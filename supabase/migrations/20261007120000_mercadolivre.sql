-- =====================================================================
-- Fase 31 · Mercado Livre (pedidos e estoque)
--
--  * Conexão por OAuth 2.0 com PKCE (Edge Function `mercadolivre`): o
--    vendedor autoriza no Mercado Livre e volta conectado. Estado e
--    code_verifier ficam aqui, sem acesso pela API, e valem 10 minutos.
--  * Tokens (acesso + renovação) ficam cifrados em
--    `integration_credentials` (mesma chave da Fase 14). A renovação troca
--    o token de renovação (uso único): a gravação confere a versão para
--    que duas renovações simultâneas não se atropelem.
--  * Uma conta do Mercado Livre só fica ligada a uma organização por vez
--    (as notificações chegam pelo id do usuário no Mercado Livre).
--  * Pedidos chegam pelas notificações (tópico orders_v2) e entram pela
--    mesma ingestão dos outros canais; o estoque sai pela mesma fila.
--  * Publicar anúncio no Mercado Livre (categoria, atributos obrigatórios,
--    tipo de anúncio) ainda não é feito pelo gerenciador de anúncios.
-- =====================================================================

create table public.oauth_states (
  state uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null,
  provider public.marketplace_provider not null,
  connection_name text not null check (char_length(connection_name) between 2 and 80),
  code_verifier text not null check (code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'),
  created_at timestamptz not null default now(),
  used_at timestamptz
);

create index oauth_states_created_idx on public.oauth_states (created_at);

-- Sem nenhum privilégio para a API: só as RPCs e o service role.
revoke all on table public.oauth_states from anon, authenticated;
alter table public.oauth_states enable row level security;

/** Início da conexão (owner/admin do vendedor). Devolve o `state`. */
create function public.oauth_begin(
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
  if private.org_kind(p_org) <> 'seller' then
    raise exception 'integrations.sellers_only' using errcode = '42501';
  end if;
  if p_provider <> 'mercadolivre' then
    raise exception 'integrations.provider_unavailable';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 2 and 80
     or p_code_verifier !~ '^[A-Za-z0-9._~-]{43,128}$' then
    raise exception 'integrations.invalid';
  end if;
  -- Limpeza de estados vencidos.
  delete from public.oauth_states where created_at < now() - interval '1 day';

  insert into public.oauth_states (organization_id, user_id, provider, connection_name, code_verifier)
  values (p_org, auth.uid(), p_provider, btrim(p_name), p_code_verifier)
  returning state into v_state;
  return v_state;
end;
$$;

/** Consome o estado (uma vez, até 10 min). Service role. */
create function public.oauth_consume(p_state uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.oauth_states%rowtype;
begin
  select * into v_row from public.oauth_states s where s.state = p_state for update;
  if v_row.state is null or v_row.used_at is not null or v_row.created_at < now() - interval '10 minutes' then
    raise exception 'integrations.oauth_state_invalid';
  end if;
  update public.oauth_states set used_at = now() where state = p_state;
  return jsonb_build_object(
    'organization_id', v_row.organization_id,
    'user_id', v_row.user_id,
    'provider', v_row.provider,
    'name', v_row.connection_name,
    'code_verifier', v_row.code_verifier
  );
end;
$$;

/** Grava (ou troca) as credenciais cifradas de uma conexão. Service role. */
create function public.put_connection_credentials(p_connection uuid, p_ciphertext text, p_config jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.integration_credentials (connection_id, ciphertext, key_version, config)
  values (p_connection, p_ciphertext, 1, coalesce(p_config, '{}'::jsonb))
  on conflict (connection_id) do update
    set ciphertext = excluded.ciphertext, config = excluded.config, updated_at = now();
end;
$$;

/**
 * Cria (ou reativa) a conexão OAuth e guarda as credenciais cifradas.
 * Service role, depois da troca do código pelo token.
 */
create function public.oauth_complete(
  p_org uuid,
  p_user uuid,
  p_provider public.marketplace_provider,
  p_name text,
  p_account text,
  p_ciphertext text,
  p_config jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_account text := btrim(coalesce(p_account, ''));
begin
  if v_account !~ '^[0-9]{1,20}$' then
    raise exception 'integrations.invalid';
  end if;
  -- Quem começou ainda precisa ser owner/admin.
  if not exists (
    select 1 from public.organization_members m
    where m.organization_id = p_org and m.user_id = p_user and m.role in ('owner', 'admin')
  ) then
    raise exception 'org.forbidden';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('oauth:' || p_provider::text || ':' || v_account, 0));
  if exists (
    select 1 from public.integration_connections c
    where c.provider = p_provider and c.external_account_id = v_account
      and c.organization_id <> p_org and c.status <> 'disconnected'
  ) then
    raise exception 'integrations.account_in_use';
  end if;

  select c.id into v_id from public.integration_connections c
  where c.organization_id = p_org and c.provider = p_provider and c.external_account_id = v_account;
  if v_id is null then
    insert into public.integration_connections (organization_id, provider, name, external_account_id, created_by)
    values (p_org, p_provider, btrim(p_name), v_account, p_user)
    returning id into v_id;
  else
    update public.integration_connections set status = 'active', name = btrim(p_name) where id = v_id;
  end if;

  -- A cifra é ligada ao id da conexão: quando ele ainda não existia, a
  -- função grava as credenciais logo depois por put_connection_credentials.
  if p_ciphertext is not null then
    perform public.put_connection_credentials(v_id, p_ciphertext, p_config);
  end if;
  return v_id;
end;
$$;

/**
 * Grava tokens renovados só se ninguém renovou antes (versão em
 * `config.token_version`). Devolve false quando perdeu a corrida.
 */
create function public.swap_connection_credentials(
  p_connection uuid,
  p_expected_version integer,
  p_ciphertext text,
  p_config jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.integration_credentials
  set ciphertext = p_ciphertext, config = p_config, updated_at = now()
  where connection_id = p_connection
    and coalesce((config ->> 'token_version')::integer, 0) = p_expected_version;
  return found;
end;
$$;

/** Conexão ativa do Mercado Livre pelo id do usuário lá (notificações). */
create function public.mercadolivre_connection(p_user_id text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from public.integration_connections c
  where c.provider = 'mercadolivre' and c.external_account_id = p_user_id and c.status = 'active'
  limit 1
$$;

grant execute on function public.oauth_begin(uuid, public.marketplace_provider, text, text) to authenticated;
grant execute on function public.oauth_consume(uuid) to service_role;
grant execute on function public.oauth_complete(uuid, uuid, public.marketplace_provider, text, text, text, jsonb) to service_role;
grant execute on function public.put_connection_credentials(uuid, text, jsonb) to service_role;
grant execute on function public.swap_connection_credentials(uuid, integer, text, jsonb) to service_role;
grant execute on function public.mercadolivre_connection(text) to service_role;

-- ---------------------------------------------------------------------
-- Vínculo manual de SKU: agora também para produto importado
-- (dropshipping), anunciando o estoque do fornecedor (Fase 29).
-- ---------------------------------------------------------------------
create or replace function public.link_listing(
  p_connection uuid,
  p_inventory_item uuid,
  p_external_id text,
  p_sync_stock boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.integration_connections%rowtype;
  v_id uuid;
begin
  select * into v_conn from public.integration_connections c where c.id = p_connection;
  if v_conn.id is null or not private.has_org_role(v_conn.organization_id, '{owner,admin}') then
    raise exception 'integrations.not_found';
  end if;
  if v_conn.status = 'disconnected' then
    raise exception 'integrations.disconnected';
  end if;
  if not exists (
    select 1 from public.inventory_items i
    where i.id = p_inventory_item and i.organization_id = v_conn.organization_id
      and (i.variant_id is not null
        or not exists (select 1 from public.product_variants pv where pv.product_id = i.product_id))
  ) then
    raise exception 'integrations.invalid_item';
  end if;

  insert into public.listing_links (
    organization_id, connection_id, inventory_item_id, external_id, sync_stock
  ) values (
    v_conn.organization_id, p_connection, p_inventory_item, btrim(p_external_id), coalesce(p_sync_stock, true)
  )
  returning id into v_id;

  if coalesce(p_sync_stock, true) and v_conn.status = 'active' then
    insert into public.stock_sync_outbox (organization_id, link_id, available)
    values (v_conn.organization_id, v_id, coalesce(private.link_available(p_inventory_item), 0));
  end if;
  return v_id;
end;
$$;
