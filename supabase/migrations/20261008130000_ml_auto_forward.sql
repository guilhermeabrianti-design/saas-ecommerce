-- =====================================================================
-- Fase 32 · Envio automático ao fornecedor (Mercado Livre)
--
--  * Pedido pago do Mercado Livre é confirmado sozinho e vira pedido de
--    fornecimento (mesma regra da confirmação manual). Ligado por padrão;
--    o vendedor desliga por conexão (`auto_forward`). Se não der (estoque,
--    fornecedor indisponível), fica pendente e o erro aparece no log.
--  * Documentos do envio vindos do Mercado Livre: etiqueta (PDF da API
--    oficial) e nota fiscal emitida pelo Faturador do Mercado Livre (DANFE
--    em PDF e XML). A Edge Function baixa e grava na pasta do envio; aqui
--    ficam o destino, a deduplicação e o aviso ao fornecedor.
--  * Destino: o pedido de fornecimento quando o envio é de um único
--    fornecedor; senão (estoque próprio ou vários fornecedores) o pedido do
--    vendedor, que repassa manualmente.
--  * Upload manual também aceita a nota (PDF ou XML), para quem emite fora
--    do Mercado Livre.
-- =====================================================================

alter table public.integration_connections
  add column auto_forward boolean not null default true;

alter table public.external_orders
  add column shipment_id text check (shipment_id is null or shipment_id ~ '^\d{1,20}$');

create index external_orders_shipment_idx on public.external_orders (connection_id, shipment_id)
  where shipment_id is not null;

update storage.buckets
set allowed_mime_types = array['application/pdf', 'image/png', 'image/jpeg', 'application/xml', 'text/xml']
where id = 'shipping-labels';

alter table public.shipping_labels
  add column kind text not null default 'label'
    check (kind in ('label', 'invoice_pdf', 'invoice_xml')),
  add column source text not null default 'upload'
    check (source in ('upload', 'mercadolivre')),
  add column external_ref text
    check (external_ref is null or external_ref ~ '^[A-Za-z0-9_-]{1,60}$');

-- O mesmo documento do Mercado Livre não entra duas vezes no mesmo envio.
create unique index shipping_labels_ml_unique
  on public.shipping_labels (coalesce(supplier_order_id, order_id), kind, external_ref)
  where source = 'mercadolivre' and voided_at is null;

-- ---------------------------------------------------------------------
-- Vendedor liga/desliga o envio automático
-- ---------------------------------------------------------------------

create function public.set_connection_auto_forward(p_connection uuid, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select c.organization_id into v_org from public.integration_connections c where c.id = p_connection;
  if v_org is null or not private.has_org_role(v_org, '{owner,admin}') then
    raise exception 'integrations.not_found';
  end if;
  if p_enabled is null then
    raise exception 'integrations.invalid';
  end if;
  update public.integration_connections set auto_forward = p_enabled where id = p_connection;
end;
$$;

-- ---------------------------------------------------------------------
-- Destino dos documentos e encaminhamento
-- ---------------------------------------------------------------------

/** Envio que recebe os documentos do pedido: fornecedor único ou o próprio pedido. */
create function private.document_target(p_order uuid)
returns table (supplier_order_id uuid, order_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sos uuid[];
  v_own boolean;
begin
  select array_agg(so.id order by so.created_at) into v_sos
  from public.supplier_orders so where so.order_id = p_order and so.status <> 'cancelled';
  select exists (
    select 1 from public.order_items oi where oi.order_id = p_order and oi.fulfillment = 'own_stock'
  ) into v_own;
  if coalesce(array_length(v_sos, 1), 0) = 1 and not v_own then
    return query select v_sos[1], null::uuid;
  else
    return query select null::uuid, p_order;
  end if;
end;
$$;

/** Mensagem legível para o log quando a confirmação automática falha. */
create function private.forward_error_message(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_code like '%source_unavailable%' then 'produto do fornecedor indisponível'
    when p_code like '%insufficient%' or p_code like '%stock%' then 'estoque insuficiente'
    when p_code like '%invalid_status%' then 'pedido não está mais pendente'
    else left(p_code, 200)
  end
$$;

/**
 * Depois da ingestão (Edge Function, service role): guarda o envio do
 * Mercado Livre, confirma o pedido se a conexão encaminha automaticamente
 * e devolve o destino dos documentos e o que já foi anexado.
 */
create function public.ml_forward_order(p_connection uuid, p_external_id text, p_shipment_id text)
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
      where l.source = 'mercadolivre' and l.voided_at is null
        and (l.supplier_order_id = v_target.supplier_order_id or l.order_id = v_target.order_id)
    ), '[]'::jsonb)
  );
end;
$$;

/** Pedido externo pelo envio (notificações do tópico shipments). */
create function public.ml_external_by_shipment(p_connection uuid, p_shipment_id text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select e.external_id from public.external_orders e
  where e.connection_id = p_connection and e.shipment_id = p_shipment_id
  limit 1
$$;

/**
 * Registra um documento do Mercado Livre já gravado no bucket (service
 * role). Duplicado = ignorado. Avisa o fornecedor (ou o vendedor).
 */
create function public.attach_marketplace_document(
  p_order uuid,
  p_kind text,
  p_path text,
  p_file_name text,
  p_external_ref text,
  p_tracking_code text
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
begin
  if p_kind not in ('label', 'invoice_pdf', 'invoice_xml') then
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
      and l.source = 'mercadolivre' and l.voided_at is null
  ) then
    return 'duplicate';
  end if;

  insert into public.shipping_labels (
    supplier_order_id, order_id, storage_path, file_name, carrier, tracking_code,
    kind, source, external_ref, uploaded_org_id
  ) values (
    v_target.supplier_order_id, v_target.order_id, p_path, left(btrim(coalesce(p_file_name, 'documento')), 120),
    case when p_kind = 'label' then 'Mercado Envios' end,
    case when p_kind = 'label' then v_tracking end,
    p_kind, 'mercadolivre', p_external_ref,
    (select o.organization_id from public.orders o where o.id = p_order)
  );

  -- XML acompanha o PDF da nota: um aviso só.
  if p_kind <> 'invoice_xml' then
    if v_target.supplier_order_id is not null then
      select * into v_so from public.supplier_orders so where so.id = v_target.supplier_order_id;
      perform private.notify_org(
        v_so.organization_id, '{owner,admin,member}', 'label.attached',
        case when p_kind = 'label' then 'Etiqueta do Mercado Livre no fornecimento #'
          else 'Nota fiscal no fornecimento #' end || v_so.number,
        case when p_kind = 'label' then 'Baixe e imprima para enviar.'
          else 'Nota fiscal emitida no Mercado Livre. Envie junto com o pacote.' end,
        '/fornecimentos/' || v_so.id
      );
    else
      perform private.notify_org(
        (select o.organization_id from public.orders o where o.id = p_order), '{owner,admin,member}',
        'label.attached',
        case when p_kind = 'label' then 'Etiqueta do Mercado Livre disponível'
          else 'Nota fiscal do Mercado Livre disponível' end,
        'Pedido com estoque próprio ou mais de um fornecedor: repasse os documentos.',
        '/pedidos/' || p_order
      );
    end if;
  end if;
  return 'attached';
end;
$$;

/** Pedido do Mercado Livre que o vendedor pede para reler (botão no pedido). */
create function public.ml_documents_request(p_order uuid)
returns table (connection_id uuid, external_id text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Cada pedido custa chamadas à API do Mercado Livre.
  perform private.enforce_rate_limit('ml.documents', auth.uid()::text, 20, 600);
  if not exists (
    select 1 from public.orders o
    where o.id = p_order and private.has_org_role(o.organization_id, '{owner,admin,member}')
  ) then
    raise exception 'orders.not_found';
  end if;
  return query
  select e.connection_id, e.external_id from public.external_orders e
  join public.integration_connections c on c.id = e.connection_id
  where e.order_id = p_order and c.provider = 'mercadolivre' and c.status = 'active'
  limit 1;
end;
$$;

-- ---------------------------------------------------------------------
-- Upload manual: etiqueta ou nota fiscal
-- ---------------------------------------------------------------------

drop function public.register_shipping_label(uuid, uuid, text, text, text, text);

create function public.register_shipping_label(
  p_supplier_order uuid,
  p_order uuid,
  p_path text,
  p_file_name text,
  p_carrier text,
  p_tracking_code text,
  p_kind text default 'label'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.shipment_org(p_supplier_order, p_order);
  v_folder text := case when p_supplier_order is not null then 'so-' || p_supplier_order else 'o-' || p_order end;
  v_so public.supplier_orders%rowtype;
  v_order public.orders%rowtype;
  v_id uuid;
  v_kind text := coalesce(p_kind, 'label');
  v_label boolean := coalesce(p_kind, 'label') = 'label';
  v_tracking text := nullif(upper(btrim(coalesce(p_tracking_code, ''))), '');
  v_carrier text := nullif(btrim(coalesce(p_carrier, '')), '');
begin
  if v_kind not in ('label', 'invoice_pdf', 'invoice_xml') then
    raise exception 'labels.invalid';
  end if;
  if (p_supplier_order is null) = (p_order is null) or v_org is null then
    raise exception 'labels.not_found';
  end if;
  if p_path is null or split_part(p_path, '/', 1) <> v_folder
     or not exists (select 1 from storage.objects o where o.bucket_id = 'shipping-labels' and o.name = p_path) then
    raise exception 'labels.file_missing';
  end if;

  if p_supplier_order is not null then
    select * into v_so from public.supplier_orders so where so.id = p_supplier_order;
    if v_so.status = 'cancelled' then
      raise exception 'labels.shipment_closed';
    end if;
  else
    select * into v_order from public.orders o where o.id = p_order;
    if v_order.status in ('cancelled', 'delivered') then
      raise exception 'labels.shipment_closed';
    end if;
  end if;

  insert into public.shipping_labels (
    supplier_order_id, order_id, storage_path, file_name, carrier, tracking_code, uploaded_by, uploaded_org_id, kind
  ) values (
    p_supplier_order, p_order, p_path, left(btrim(coalesce(p_file_name, 'etiqueta')), 120),
    case when v_label then v_carrier end, case when v_label then v_tracking end,
    auth.uid(), v_org, v_kind
  )
  returning id into v_id;

  if p_supplier_order is not null and v_kind <> 'invoice_xml' then
    perform private.notify_org(
      case when v_org = v_so.organization_id then v_so.seller_organization_id else v_so.organization_id end,
      '{owner,admin,member}', 'label.attached',
      case when v_label then 'Etiqueta anexada ao fornecimento #' else 'Nota fiscal anexada ao fornecimento #' end
        || v_so.number,
      case when v_label then coalesce('Rastreio ' || v_tracking || '. ', '') || 'Baixe e imprima para enviar.'
        else 'Envie a nota junto com o pacote.' end,
      case when v_org = v_so.organization_id then '/pedidos/' || v_so.order_id else '/fornecimentos/' || v_so.id end
    );
  end if;
  return v_id;
end;
$$;

revoke execute on function public.set_connection_auto_forward(uuid, boolean) from public, anon;
revoke execute on function public.ml_forward_order(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.ml_external_by_shipment(uuid, text) from public, anon, authenticated;
revoke execute on function public.attach_marketplace_document(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.ml_documents_request(uuid) from public, anon;
revoke execute on function public.register_shipping_label(uuid, uuid, text, text, text, text, text) from public, anon;
revoke execute on function private.document_target(uuid) from public, anon, authenticated;
revoke execute on function private.forward_error_message(text) from public, anon, authenticated;

grant execute on function public.set_connection_auto_forward(uuid, boolean) to authenticated;
grant execute on function public.ml_forward_order(uuid, text, text) to service_role;
grant execute on function public.ml_external_by_shipment(uuid, text) to service_role;
grant execute on function public.attach_marketplace_document(uuid, text, text, text, text, text) to service_role;
grant execute on function public.ml_documents_request(uuid) to authenticated;
grant execute on function public.register_shipping_label(uuid, uuid, text, text, text, text, text) to authenticated;
