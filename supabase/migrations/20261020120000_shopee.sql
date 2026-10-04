-- =====================================================================
-- Fase 38 · Shopee (pedidos, envio ao fornecedor com etiqueta e estoque)
--
--  * Conexão por autorização da loja (Edge Function `shopee`): o vendedor
--    autoriza na Shopee e volta conectado. Mesmo `oauth_states` do Mercado
--    Livre (o `state` vai dentro do endereço de volta). Uma loja da Shopee
--    só fica ligada a uma empresa por vez (`oauth_complete`).
--  * Pedidos chegam pelas notificações (push) assinadas pela Shopee e
--    entram pela mesma ingestão; o encaminhamento automático ao fornecedor
--    é o mesmo do Mercado Livre (`auto_forward` da conexão).
--  * Etiqueta da Shopee vai para o envio do fornecedor, como a do Mercado
--    Livre: os documentos de marketplace deixam de ser só do Mercado Livre
--    (`shipping_labels.source`).
--  * Estoque: a Shopee atualiza por item/variação (ids dela). O vínculo de
--    SKU guarda essa referência (`listing_links.external_ref`), aprendida
--    no primeiro pedido ou na primeira busca pelo SKU.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Conexão
-- ---------------------------------------------------------------------

/** Início do OAuth: Mercado Livre e Shopee (vendedor) e Bling (vendedor ou fornecedor). */
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
  if p_provider::text not in ('mercadolivre', 'shopee', 'bling') then
    raise exception 'integrations.provider_unavailable';
  end if;
  if p_provider::text <> 'bling' and private.org_kind(p_org) <> 'seller' then
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

/** Conexão ativa de um marketplace pela conta de lá (notificações). Service role. */
create function public.marketplace_connection(p_provider text, p_account text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from public.integration_connections c
  where c.provider::text = p_provider and c.external_account_id = p_account and c.status = 'active'
  limit 1
$$;

-- ---------------------------------------------------------------------
-- Referência do item no marketplace (estoque)
-- ---------------------------------------------------------------------

alter table public.listing_links
  add column external_ref text check (external_ref is null or external_ref ~ '^[A-Za-z0-9:_-]{1,120}$');

/**
 * Guarda a referência do item no marketplace para os SKUs vinculados
 * (service role): [{"sku": "...", "ref": "..."}]. SKU sem vínculo é ignorado.
 */
create function public.remember_listing_refs(p_connection uuid, p_refs jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if jsonb_typeof(p_refs) <> 'array' or jsonb_array_length(p_refs) > 100 then
    raise exception 'integrations.invalid';
  end if;
  update public.listing_links l
  set external_ref = r.ref
  from (
    select distinct on (x ->> 'sku') x ->> 'sku' as sku, x ->> 'ref' as ref
    from jsonb_array_elements(p_refs) x
    where jsonb_typeof(x) = 'object' and coalesce(x ->> 'ref', '') ~ '^[A-Za-z0-9:_-]{1,120}$'
  ) r
  where l.connection_id = p_connection and l.external_id = r.sku
    and l.external_ref is distinct from r.ref;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Trocar o SKU do vínculo esquece a referência antiga.
create function private.listing_links_reset_ref()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.external_id is distinct from old.external_id
     and new.external_ref is not distinct from old.external_ref then
    new.external_ref := null;
  end if;
  return new;
end;
$$;

create trigger listing_links_reset_ref
  before update of external_id on public.listing_links
  for each row execute function private.listing_links_reset_ref();

drop function public.claim_stock_sync(integer);

/** Worker: reivindica pendências vencidas (ou com reivindicação vencida há 10 min). */
create function public.claim_stock_sync(p_limit integer default 20)
returns table (
  id uuid,
  connection_id uuid,
  provider public.marketplace_provider,
  external_account_id text,
  external_id text,
  available integer,
  link_id uuid,
  external_ref text
)
language sql
security definer
set search_path = ''
as $$
  with picked as (
    select o.id from public.stock_sync_outbox o
    where o.done_at is null
      and o.next_attempt_at <= now()
      and (o.claimed_at is null or o.claimed_at < now() - interval '10 minutes')
    order by o.created_at
    limit greatest(least(coalesce(p_limit, 20), 100), 1)
    for update skip locked
  ),
  claimed as (
    update public.stock_sync_outbox o
    set claimed_at = now(), attempts = o.attempts + 1
    from picked where o.id = picked.id
    returning o.id, o.link_id, o.available
  )
  select cl.id, c.id, c.provider, c.external_account_id, l.external_id, cl.available, l.id, l.external_ref
  from claimed cl
  join public.listing_links l on l.id = cl.link_id
  join public.integration_connections c on c.id = l.connection_id
$$;

-- ---------------------------------------------------------------------
-- Documentos de marketplace: Mercado Livre e Shopee
-- ---------------------------------------------------------------------

alter table public.shipping_labels drop constraint shipping_labels_source_check;
alter table public.shipping_labels add constraint shipping_labels_source_check
  check (source in ('upload', 'mercadolivre', 'shopee'));

drop index public.shipping_labels_ml_unique;
create unique index shipping_labels_marketplace_unique
  on public.shipping_labels (coalesce(supplier_order_id, order_id), source, kind, external_ref)
  where source <> 'upload' and voided_at is null;

drop function public.attach_marketplace_document(uuid, text, text, text, text, text);

/**
 * Registra um documento de marketplace já gravado no bucket (service
 * role). Duplicado = ignorado. Avisa o fornecedor (ou o vendedor).
 */
create function public.attach_marketplace_document(
  p_order uuid,
  p_kind text,
  p_path text,
  p_file_name text,
  p_external_ref text,
  p_tracking_code text,
  p_source text default 'mercadolivre',
  p_carrier text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target record;
  v_folder text;
  v_so public.supplier_orders%rowtype;
  v_tracking text := nullif(upper(btrim(coalesce(p_tracking_code, ''))), '');
  v_name text := case p_source when 'mercadolivre' then 'Mercado Livre' when 'shopee' then 'Shopee' end;
  v_carrier text := coalesce(
    nullif(left(btrim(coalesce(p_carrier, '')), 60), ''),
    case p_source when 'mercadolivre' then 'Mercado Envios' when 'shopee' then 'Shopee' end
  );
begin
  if p_kind not in ('label', 'invoice_pdf', 'invoice_xml') or v_name is null then
    raise exception 'labels.invalid';
  end if;
  select * into v_target from private.document_target(p_order);
  if not exists (select 1 from public.orders o where o.id = p_order) then
    raise exception 'labels.not_found';
  end if;
  v_folder := case when v_target.supplier_order_id is not null
    then 'so-' || v_target.supplier_order_id else 'o-' || v_target.order_id end;
  if p_path is null or split_part(p_path, '/', 1) <> v_folder
     or not exists (select 1 from storage.objects o where o.bucket_id = 'shipping-labels' and o.name = p_path) then
    raise exception 'labels.file_missing';
  end if;
  if v_tracking is not null and v_tracking !~ '^[A-Z0-9-]{4,60}$' then
    v_tracking := null;
  end if;

  if exists (
    select 1 from public.shipping_labels l
    where coalesce(l.supplier_order_id, l.order_id) = coalesce(v_target.supplier_order_id, v_target.order_id)
      and l.kind = p_kind and l.external_ref = p_external_ref
      and l.source = p_source and l.voided_at is null
  ) then
    return 'duplicate';
  end if;

  insert into public.shipping_labels (
    supplier_order_id, order_id, storage_path, file_name, carrier, tracking_code,
    kind, source, external_ref, uploaded_org_id
  ) values (
    v_target.supplier_order_id, v_target.order_id, p_path, left(btrim(coalesce(p_file_name, 'documento')), 120),
    case when p_kind = 'label' then v_carrier end,
    case when p_kind = 'label' then v_tracking end,
    p_kind, p_source, p_external_ref,
    (select o.organization_id from public.orders o where o.id = p_order)
  );

  -- XML acompanha o PDF da nota: um aviso só.
  if p_kind <> 'invoice_xml' then
    if v_target.supplier_order_id is not null then
      select * into v_so from public.supplier_orders so where so.id = v_target.supplier_order_id;
      perform private.notify_org(
        v_so.organization_id, '{owner,admin,member}', 'label.attached',
        case when p_kind = 'label' then 'Etiqueta ' || case p_source when 'shopee' then 'da ' else 'do ' end
            || v_name || ' no fornecimento #'
          else 'Nota fiscal no fornecimento #' end || v_so.number,
        case when p_kind = 'label' then 'Baixe e imprima para enviar.'
          else 'Nota fiscal emitida no ' || v_name || '. Envie junto com o pacote.' end,
        '/fornecimentos/' || v_so.id
      );
    else
      perform private.notify_org(
        (select o.organization_id from public.orders o where o.id = p_order), '{owner,admin,member}',
        'label.attached',
        case when p_kind = 'label' then 'Etiqueta ' || case p_source when 'shopee' then 'da ' else 'do ' end
            || v_name || ' disponível'
          else 'Nota fiscal do ' || v_name || ' disponível' end,
        'Pedido com estoque próprio ou mais de um fornecedor: repasse os documentos.',
        '/pedidos/' || p_order
      );
    end if;
  end if;
  return 'attached';
end;
$$;

/**
 * Depois da ingestão (Edge Function, service role): guarda o envio do
 * Mercado Livre, confirma o pedido se a conexão encaminha automaticamente
 * e devolve o destino dos documentos e o que já foi anexado (de qualquer
 * marketplace). Shopee chama sem envio.
 */
create or replace function public.ml_forward_order(p_connection uuid, p_external_id text, p_shipment_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.integration_connections%rowtype;
  v_order public.orders%rowtype;
  v_order_id uuid;
  v_target record;
  v_forwarded boolean := false;
begin
  select * into v_conn from public.integration_connections c where c.id = p_connection;
  select e.order_id into v_order_id from public.external_orders e
  where e.connection_id = p_connection and e.external_id = p_external_id;
  if v_conn.id is null or v_order_id is null then
    return jsonb_build_object('status', 'no_order');
  end if;

  if p_shipment_id ~ '^\d{1,20}$' then
    update public.external_orders set shipment_id = p_shipment_id
    where connection_id = p_connection and external_id = p_external_id
      and shipment_id is distinct from p_shipment_id;
  end if;

  select * into v_order from public.orders o where o.id = v_order_id for update;
  if v_order.status = 'pending' and v_conn.auto_forward and v_conn.status = 'active' then
    begin
      perform private.confirm_order_core(v_order_id);
      v_forwarded := true;
      insert into public.integration_events (
        organization_id, connection_id, direction, kind, external_id, status, message
      ) values (
        v_conn.organization_id, p_connection, 'inbound', 'order.forwarded', p_external_id, 'ok',
        'Pedido #' || v_order.number || ' confirmado automaticamente e enviado ao fornecedor'
      );
    exception when others then
      insert into public.integration_events (
        organization_id, connection_id, direction, kind, external_id, status, message
      ) values (
        v_conn.organization_id, p_connection, 'inbound', 'order.forward_failed', p_external_id, 'error',
        left('Pedido #' || v_order.number || ' ficou pendente: ' || private.forward_error_message(sqlerrm), 500)
      );
      perform private.notify_org(
        v_conn.organization_id, '{owner,admin}', 'order.forward_failed',
        'Pedido #' || v_order.number || ' não foi enviado ao fornecedor',
        'Confirmação automática falhou (' || private.forward_error_message(sqlerrm) || '). Confira o pedido.',
        '/pedidos/' || v_order_id
      );
    end;
  end if;

  select * into v_target from private.document_target(v_order_id);
  return jsonb_build_object(
    'status', (select o.status from public.orders o where o.id = v_order_id),
    'forwarded', v_forwarded,
    'order_id', v_order_id,
    'supplier_order_id', v_target.supplier_order_id,
    'target_order_id', v_target.order_id,
    'existing', coalesce((
      select jsonb_agg(l.kind || ':' || l.external_ref)
      from public.shipping_labels l
      where l.source = v_conn.provider::text and l.voided_at is null
        and (l.supplier_order_id = v_target.supplier_order_id or l.order_id = v_target.order_id)
    ), '[]'::jsonb)
  );
end;
$$;

/** Encaminhamento genérico (Shopee, TikTok Shop): mesmo do Mercado Livre, sem envio. */
create function public.marketplace_forward_order(p_connection uuid, p_external_id text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.ml_forward_order(p_connection, p_external_id, null)
$$;

/** Marketplace de onde veio o pedido (botão "Buscar documentos"). Membros do vendedor. */
create function public.order_marketplace(p_order uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select c.provider::text
  from public.orders o
  join public.external_orders e on e.order_id = o.id
  join public.integration_connections c on c.id = e.connection_id
  where o.id = p_order and private.has_org_role(o.organization_id, '{owner,admin,member}')
  limit 1
$$;

/** Pedido de um marketplace que o vendedor pede para reler (botão no pedido). */
create function public.marketplace_documents_request(p_order uuid, p_provider text)
returns table (connection_id uuid, external_id text, external_account_id text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Cada pedido custa chamadas à API do marketplace.
  perform private.enforce_rate_limit('marketplace.documents', auth.uid()::text, 20, 600);
  if not exists (
    select 1 from public.orders o
    where o.id = p_order and private.has_org_role(o.organization_id, '{owner,admin,member}')
  ) then
    raise exception 'orders.not_found';
  end if;
  return query
  select e.connection_id, e.external_id, c.external_account_id from public.external_orders e
  join public.integration_connections c on c.id = e.connection_id
  where e.order_id = p_order and c.provider::text = p_provider and c.status = 'active'
  limit 1;
end;
$$;

revoke execute on function public.marketplace_connection(text, text) from public, anon, authenticated;
revoke execute on function public.remember_listing_refs(uuid, jsonb) from public, anon, authenticated;
revoke execute on function private.listing_links_reset_ref() from public, anon, authenticated;
revoke execute on function public.claim_stock_sync(integer) from public, anon, authenticated;
revoke execute on function public.attach_marketplace_document(uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.marketplace_forward_order(uuid, text) from public, anon, authenticated;
revoke execute on function public.order_marketplace(uuid) from public, anon;
revoke execute on function public.marketplace_documents_request(uuid, text) from public, anon;

grant execute on function public.marketplace_connection(text, text) to service_role;
grant execute on function public.remember_listing_refs(uuid, jsonb) to service_role;
grant execute on function public.claim_stock_sync(integer) to service_role;
grant execute on function public.attach_marketplace_document(uuid, text, text, text, text, text, text, text) to service_role;
grant execute on function public.marketplace_forward_order(uuid, text) to service_role;
grant execute on function public.order_marketplace(uuid) to authenticated;
grant execute on function public.marketplace_documents_request(uuid, text) to authenticated;
