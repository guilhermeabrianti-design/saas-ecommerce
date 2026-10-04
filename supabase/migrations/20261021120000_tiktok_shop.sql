-- =====================================================================
-- Fase 39 · TikTok Shop (pedidos, envio ao fornecedor com etiqueta e estoque)
--
--  * Conexão por autorização (Edge Function `tiktok`), com o mesmo
--    `oauth_states` dos outros marketplaces. Depois da troca do código, a
--    função busca as lojas autorizadas (prefere a do Brasil) e guarda o
--    `shop_cipher` junto das credenciais cifradas. Uma loja da TikTok Shop
--    só fica ligada a uma empresa por vez.
--  * Pedidos chegam pelo webhook assinado e entram pela mesma ingestão; o
--    encaminhamento ao fornecedor é o mesmo dos outros marketplaces.
--  * Etiqueta da TikTok Shop (por pacote) vai para o envio do fornecedor.
--  * Estoque: SKU do vendedor → produto, SKU e depósito na TikTok Shop,
--    guardados no vínculo (`listing_links.external_ref`, Fase 38).
-- =====================================================================

/** Início do OAuth: Mercado Livre, Shopee e TikTok Shop (vendedor) e Bling (vendedor ou fornecedor). */
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
  if p_provider::text not in ('mercadolivre', 'shopee', 'tiktok', 'bling') then
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

alter table public.shipping_labels drop constraint shipping_labels_source_check;
alter table public.shipping_labels add constraint shipping_labels_source_check
  check (source in ('upload', 'mercadolivre', 'shopee', 'tiktok'));

/**
 * Registra um documento de marketplace já gravado no bucket (service
 * role). Duplicado = ignorado. Avisa o fornecedor (ou o vendedor).
 */
create or replace function public.attach_marketplace_document(
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
  v_name text := case p_source when 'mercadolivre' then 'Mercado Livre' when 'shopee' then 'Shopee'
    when 'tiktok' then 'TikTok Shop' end;
  v_carrier text := coalesce(
    nullif(left(btrim(coalesce(p_carrier, '')), 60), ''),
    case p_source when 'mercadolivre' then 'Mercado Envios' when 'shopee' then 'Shopee'
      when 'tiktok' then 'TikTok Shop' end
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
        case when p_kind = 'label' then 'Etiqueta ' || case when p_source = 'mercadolivre' then 'do ' else 'da ' end
            || v_name || ' no fornecimento #'
          else 'Nota fiscal no fornecimento #' end || v_so.number,
        case when p_kind = 'label' then 'Baixe e imprima para enviar.'
          else 'Nota fiscal emitida ' || case when p_source = 'mercadolivre' then 'no ' else 'na ' end || v_name || '. Envie junto com o pacote.' end,
        '/fornecimentos/' || v_so.id
      );
    else
      perform private.notify_org(
        (select o.organization_id from public.orders o where o.id = p_order), '{owner,admin,member}',
        'label.attached',
        case when p_kind = 'label' then 'Etiqueta ' || case when p_source = 'mercadolivre' then 'do ' else 'da ' end
            || v_name || ' disponível'
          else 'Nota fiscal ' || case when p_source = 'mercadolivre' then 'do ' else 'da ' end || v_name || ' disponível' end,
        'Pedido com estoque próprio ou mais de um fornecedor: repasse os documentos.',
        '/pedidos/' || p_order
      );
    end if;
  end if;
  return 'attached';
end;
$$;
