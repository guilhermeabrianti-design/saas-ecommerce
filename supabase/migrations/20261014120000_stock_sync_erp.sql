-- =====================================================================
-- Fase 36 · Estoque sincronizado: planilha e ERP (Bling / Tiny)
--
--  * Quem vende em outros lugares não precisa ajustar o estoque à mão:
--      - Planilha: SKU + quantidade (CSV). Cada linha vira uma contagem de
--        inventário (motivo "count", com nota), com o mesmo controle do
--        ajuste manual. Owner/admin, vendedor ou fornecedor.
--      - ERP: Bling (OAuth) ou Tiny (token da API). O ERP é a fonte do
--        saldo: a cada sincronização o saldo dos SKUs iguais vira o nosso.
--        A sincronização roda por agendamento (Edge Function `erp`, com
--        o mesmo segredo do worker de estoque) ou pelo botão.
--  * Mudou o saldo aqui → a fila de estoque já envia ao Mercado Livre.
--  * Só estoque próprio: produto importado do catálogo (dropshipping) usa
--    o estoque do fornecedor e fica de fora.
--  * Saldo do ERP abaixo do reservado por pedidos daqui: fica no reservado
--    e o item é informado como conflito (nada de reserva quebrada).
-- =====================================================================

alter type public.marketplace_provider add value if not exists 'bling';
alter type public.marketplace_provider add value if not exists 'tiny';

alter table public.integration_connections drop constraint integration_connections_supported_provider;
alter table public.integration_connections add constraint integration_connections_supported_provider
  check (provider::text in ('mercadolivre', 'shopee', 'tiktok', 'bling', 'tiny'));
alter table public.oauth_states drop constraint oauth_states_supported_provider;
alter table public.oauth_states add constraint oauth_states_supported_provider
  check (provider::text in ('mercadolivre', 'shopee', 'tiktok', 'bling'));

alter table public.integration_connections
  add column sync_cursor text check (sync_cursor is null or char_length(sync_cursor) <= 40),
  add column last_sync_at timestamptz,
  add column last_sync_summary jsonb;

-- ---------------------------------------------------------------------
-- Núcleo: definir o saldo de um item (sem checagem de papel; quem chama valida)
-- ---------------------------------------------------------------------

/** Itens de estoque próprio da organização por SKU (sem dropshipping). */
create function private.own_stock_items(p_org uuid)
returns table (item_id uuid, sku text, on_hand integer, reserved integer)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, coalesce(v.sku, p.sku), i.on_hand, i.reserved
  from public.inventory_items i
  join public.products p on p.id = i.product_id
  left join public.product_variants v on v.id = i.variant_id
  where i.organization_id = p_org and p.source_listing_id is null and p.status <> 'archived'
    and (i.variant_id is not null
         or not exists (select 1 from public.product_variants pv where pv.product_id = i.product_id))
$$;

/**
 * Define o saldo físico (contagem). Abaixo do reservado → fica no
 * reservado. Devolve 'updated', 'unchanged' ou 'clamped'.
 */
create function private.set_on_hand(p_item uuid, p_quantity integer, p_note text, p_actor uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.inventory_items%rowtype;
  v_target integer;
begin
  select * into v_item from public.inventory_items i where i.id = p_item for update;
  v_target := greatest(p_quantity, v_item.reserved);
  if v_target = v_item.on_hand then
    return case when p_quantity < v_item.reserved then 'clamped' else 'unchanged' end;
  end if;
  update public.inventory_items set on_hand = v_target where id = p_item;
  insert into public.inventory_movements (
    organization_id, item_id, quantity_delta, on_hand_after, reason, note, created_by, request_id
  ) values (
    v_item.organization_id, p_item, v_target - v_item.on_hand, v_target, 'count',
    left(p_note, 200), p_actor, gen_random_uuid()
  );
  return case when p_quantity < v_item.reserved then 'clamped' else 'updated' end;
end;
$$;

/**
 * Aplica [{sku, quantity}] ao estoque próprio. SKU sem diferenciar
 * maiúsculas; repetido vale a última linha. Resumo com contagens e listas
 * (até 50) de SKUs desconhecidos, inválidos e em conflito.
 */
create function private.apply_stock_rows(p_org uuid, p_rows jsonb, p_note text, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_item uuid;
  v_result text;
  v_updated integer := 0;
  v_unchanged integer := 0;
  v_unknown text[] := '{}';
  v_invalid text[] := '{}';
  v_clamped text[] := '{}';
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'stock.invalid_rows';
  end if;

  for r in
    select distinct on (lower(btrim(x ->> 'sku')))
      btrim(x ->> 'sku') as sku, x ->> 'quantity' as qty
    from jsonb_array_elements(p_rows) with ordinality as t(x, n)
    where nullif(btrim(x ->> 'sku'), '') is not null
    order by lower(btrim(x ->> 'sku')), n desc
  loop
    if r.qty is null or r.qty !~ '^\d{1,9}(\.0+)?$' then
      v_invalid := v_invalid || r.sku;
      continue;
    end if;
    select s.item_id into v_item from private.own_stock_items(p_org) s
    where lower(s.sku) = lower(r.sku) limit 1;
    if v_item is null then
      v_unknown := v_unknown || r.sku;
      continue;
    end if;
    v_result := private.set_on_hand(v_item, floor(r.qty::numeric)::integer, p_note, p_actor);
    if v_result = 'updated' then
      v_updated := v_updated + 1;
    elsif v_result = 'clamped' then
      v_clamped := v_clamped || r.sku;
    else
      v_unchanged := v_unchanged + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'updated', v_updated,
    'unchanged', v_unchanged,
    'unknown_count', coalesce(array_length(v_unknown, 1), 0),
    'unknown', to_jsonb(v_unknown[1:50]),
    'invalid', to_jsonb(v_invalid[1:50]),
    'clamped', to_jsonb(v_clamped[1:50])
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Planilha
-- ---------------------------------------------------------------------

/** Atualiza o estoque por planilha (owner/admin). Erros: org.forbidden, stock.invalid_rows. */
create function public.bulk_set_stock(p_org uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_org_role(p_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  perform private.enforce_rate_limit('stock.bulk', auth.uid()::text, 20, 3600);
  return private.apply_stock_rows(p_org, p_rows, 'Planilha', auth.uid());
end;
$$;

-- ---------------------------------------------------------------------
-- ERP (Bling / Tiny)
-- ---------------------------------------------------------------------

/** Início do OAuth: Mercado Livre (vendedor) e Bling (vendedor ou fornecedor). */
create or replace function public.oauth_begin(
  p_org uuid,
  p_provider public.marketplace_provider,
  p_name text,
  p_code_verifier text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state uuid;
begin
  if not private.has_org_role(p_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  if p_provider::text not in ('mercadolivre', 'bling') then
    raise exception 'integrations.provider_unavailable';
  end if;
  if p_provider::text = 'mercadolivre' and private.org_kind(p_org) <> 'seller' then
    raise exception 'integrations.sellers_only' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 2 and 80
     or p_code_verifier !~ '^[A-Za-z0-9._~-]{43,128}$' then
    raise exception 'integrations.invalid';
  end if;
  delete from public.oauth_states where created_at < now() - interval '1 day';

  insert into public.oauth_states (organization_id, user_id, provider, connection_name, code_verifier)
  values (p_org, auth.uid(), p_provider, btrim(p_name), p_code_verifier)
  returning state into v_state;
  return v_state;
end;
$$;

/**
 * Cria (ou reativa) a conexão de ERP da organização — uma por ERP.
 * Service role (Edge Function `erp`), depois de validar o acesso.
 */
create function public.erp_upsert_connection(p_org uuid, p_user uuid, p_provider text, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_provider not in ('bling', 'tiny') or char_length(btrim(coalesce(p_name, ''))) not between 2 and 80 then
    raise exception 'integrations.invalid';
  end if;
  if not exists (
    select 1 from public.organization_members m
    where m.organization_id = p_org and m.user_id = p_user and m.role in ('owner', 'admin')
  ) then
    raise exception 'org.forbidden';
  end if;
  select c.id into v_id from public.integration_connections c
  where c.organization_id = p_org and c.provider::text = p_provider;
  if v_id is null then
    insert into public.integration_connections (organization_id, provider, name, external_account_id, created_by)
    values (p_org, p_provider::public.marketplace_provider, btrim(p_name), p_provider, p_user)
    returning id into v_id;
  else
    update public.integration_connections
    set status = 'active', name = btrim(p_name), sync_cursor = null
    where id = v_id;
  end if;
  return v_id;
end;
$$;

/** Conexão de ERP que quem chama pode sincronizar agora (owner/admin). */
create function public.erp_sync_request(p_connection uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.integration_connections%rowtype;
begin
  select * into v_conn from public.integration_connections c where c.id = p_connection;
  if v_conn.id is null or v_conn.provider::text not in ('bling', 'tiny')
     or not private.has_org_role(v_conn.organization_id, '{owner,admin}') then
    raise exception 'integrations.not_found';
  end if;
  if v_conn.status <> 'active' then
    raise exception 'integrations.disconnected';
  end if;
  perform private.enforce_rate_limit('erp.sync', auth.uid()::text, 12, 3600);
  return v_conn.provider::text;
end;
$$;

/** Conexões de ERP ativas para o agendamento (as mais antigas primeiro). Service role. */
create function public.erp_due_connections(p_limit integer)
returns table (connection_id uuid, provider text, organization_id uuid, sync_cursor text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.provider::text, c.organization_id, c.sync_cursor
  from public.integration_connections c
  join public.organizations o on o.id = c.organization_id
  where c.provider::text in ('bling', 'tiny') and c.status = 'active' and o.suspended_at is null
  order by c.last_sync_at nulls first
  limit least(greatest(coalesce(p_limit, 10), 1), 50)
$$;

/** SKUs de estoque próprio da conexão (para consultar no ERP). Service role. */
create function public.erp_skus(p_connection uuid)
returns table (sku text)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct s.sku from public.integration_connections c
  cross join lateral private.own_stock_items(c.organization_id) s
  where c.id = p_connection
  order by s.sku
$$;

/**
 * Aplica os saldos lidos no ERP, guarda o cursor (Tiny) e o resumo, e
 * registra o evento. Service role.
 */
create function public.erp_apply_stock(p_connection uuid, p_rows jsonb, p_cursor text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.integration_connections%rowtype;
  v_summary jsonb;
  v_label text;
begin
  select * into v_conn from public.integration_connections c where c.id = p_connection for update;
  if v_conn.id is null or v_conn.provider::text not in ('bling', 'tiny') then
    raise exception 'integrations.not_found';
  end if;
  if v_conn.status <> 'active' then
    return jsonb_build_object('status', 'inactive');
  end if;
  v_label := case v_conn.provider::text when 'bling' then 'Bling' else 'Tiny' end;
  v_summary := private.apply_stock_rows(v_conn.organization_id, p_rows, 'Sincronizado do ' || v_label, null);

  update public.integration_connections
  set last_sync_at = now(),
      last_sync_summary = v_summary,
      last_event_at = now(),
      sync_cursor = coalesce(nullif(btrim(coalesce(p_cursor, '')), ''), sync_cursor)
  where id = p_connection;

  insert into public.integration_events (
    organization_id, connection_id, direction, kind, status, message
  ) values (
    v_conn.organization_id, p_connection, 'inbound', 'stock.sync',
    (case when jsonb_array_length(v_summary -> 'clamped') > 0 then 'error' else 'ok' end)::public.integration_event_status,
    left(format('%s atualizado(s), %s igual(is), %s SKU(s) sem cadastro aqui%s',
      v_summary ->> 'updated', v_summary ->> 'unchanged', v_summary ->> 'unknown_count',
      case when jsonb_array_length(v_summary -> 'clamped') > 0
        then '; abaixo do reservado: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(v_summary -> 'clamped') x)
        else '' end), 500)
  );
  return v_summary;
end;
$$;

/** Falha da sincronização (credencial recusada, ERP fora do ar). Service role. */
create function public.erp_sync_failed(p_connection uuid, p_message text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.integration_connections
  set last_sync_at = now(),
      last_sync_summary = jsonb_build_object('error', left(coalesce(p_message, 'erro'), 300))
  where id = p_connection;
  insert into public.integration_events (organization_id, connection_id, direction, kind, status, message)
  select c.organization_id, c.id, 'inbound', 'stock.sync', 'error', left(coalesce(p_message, 'erro'), 500)
  from public.integration_connections c where c.id = p_connection;
end;
$$;

revoke execute on function private.own_stock_items(uuid) from public, anon, authenticated;
revoke execute on function private.set_on_hand(uuid, integer, text, uuid) from public, anon, authenticated;
revoke execute on function private.apply_stock_rows(uuid, jsonb, text, uuid) from public, anon, authenticated;
revoke execute on function public.bulk_set_stock(uuid, jsonb) from public, anon;
revoke execute on function public.erp_upsert_connection(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.erp_sync_request(uuid) from public, anon;
revoke execute on function public.erp_due_connections(integer) from public, anon, authenticated;
revoke execute on function public.erp_skus(uuid) from public, anon, authenticated;
revoke execute on function public.erp_apply_stock(uuid, jsonb, text) from public, anon, authenticated;
revoke execute on function public.erp_sync_failed(uuid, text) from public, anon, authenticated;

grant execute on function public.bulk_set_stock(uuid, jsonb) to authenticated;
grant execute on function public.erp_sync_request(uuid) to authenticated;
grant execute on function public.erp_upsert_connection(uuid, uuid, text, text) to service_role;
grant execute on function public.erp_due_connections(integer) to service_role;
grant execute on function public.erp_skus(uuid) to service_role;
grant execute on function public.erp_apply_stock(uuid, jsonb, text) to service_role;
grant execute on function public.erp_sync_failed(uuid, text) to service_role;
