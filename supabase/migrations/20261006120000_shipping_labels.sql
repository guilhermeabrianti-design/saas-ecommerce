-- =====================================================================
-- Fase 30 · Etiquetas de envio
--
--  * Etiqueta anexada ao envio: PDF ou imagem enviada pelo vendedor ou
--    pelo fornecedor, vinculada a um pedido de fornecimento (dropshipping:
--    ex. etiqueta gerada pelo marketplace que o vendedor repassa ao
--    fornecedor) ou a um pedido do próprio vendedor (estoque próprio).
--  * Arquivos no bucket privado `shipping-labels`, pasta por envio
--    (`so-<id>` ou `o-<id>`); só quem participa do envio lê e envia.
--  * Geração pela API oficial (Melhor Envio, Correios com contrato) não é
--    feita aqui: depende de contrato/credenciais da plataforma. Sem isso,
--    o fluxo é o upload manual — nada de etiqueta simulada.
--  * "Em trânsito" é mostrado a partir do envio com rastreio; o status
--    automático por evento da transportadora depende da mesma API.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shipping-labels', 'shipping-labels', false, 5242880,
        array['application/pdf', 'image/png', 'image/jpeg'])
on conflict (id) do nothing;

create table public.shipping_labels (
  id uuid primary key default gen_random_uuid(),
  supplier_order_id uuid references public.supplier_orders (id) on delete cascade,
  order_id uuid references public.orders (id) on delete cascade,
  storage_path text not null unique check (char_length(storage_path) between 10 and 300),
  file_name text not null check (char_length(file_name) between 1 and 120),
  carrier text check (carrier is null or char_length(carrier) between 2 and 60),
  tracking_code text check (tracking_code is null or tracking_code ~ '^[A-Za-z0-9-]{4,60}$'),
  uploaded_by uuid,
  uploaded_org_id uuid references public.organizations (id) on delete set null,
  voided_at timestamptz,
  voided_by uuid,
  created_at timestamptz not null default now(),
  check ((supplier_order_id is null) <> (order_id is null))
);

create index shipping_labels_so_idx on public.shipping_labels (supplier_order_id) where supplier_order_id is not null;
create index shipping_labels_order_idx on public.shipping_labels (order_id) where order_id is not null;

-- ---------------------------------------------------------------------
-- Acesso
-- ---------------------------------------------------------------------

/**
 * Organização do chamador que participa do envio: fornecedor ou vendedor
 * do pedido de fornecimento; vendedor do pedido de estoque próprio. Nulo =
 * sem acesso.
 */
create function private.shipment_org(p_supplier_order uuid, p_order uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_supplier_order is not null then (
      select case
        when private.is_org_member(so.organization_id) then so.organization_id
        when private.is_org_member(so.seller_organization_id) then so.seller_organization_id
      end
      from public.supplier_orders so where so.id = p_supplier_order)
    when p_order is not null then (
      select o.organization_id from public.orders o
      where o.id = p_order and private.is_org_member(o.organization_id))
  end
$$;

/** Pasta do arquivo (`so-<uuid>/…` ou `o-<uuid>/…`) → acesso ao envio. */
create function private.label_file_access(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_folder text := split_part(coalesce(p_name, ''), '/', 1);
  v_id uuid;
begin
  if v_folder !~ '^(so|o)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_id := substring(v_folder from position('-' in v_folder) + 1)::uuid;
  return private.shipment_org(
    case when v_folder like 'so-%' then v_id end,
    case when v_folder like 'o-%' then v_id end
  ) is not null;
end;
$$;

grant execute on function private.shipment_org(uuid, uuid) to authenticated;
grant execute on function private.label_file_access(text) to authenticated;

create policy "shipping-labels: quem participa do envio lê"
  on storage.objects for select to authenticated
  using (bucket_id = 'shipping-labels' and private.label_file_access(name));

create policy "shipping-labels: quem participa do envio envia"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'shipping-labels' and private.label_file_access(name));

revoke all on table public.shipping_labels from anon, authenticated;
grant select on table public.shipping_labels to authenticated;
alter table public.shipping_labels enable row level security;

create policy "shipping_labels: quem participa do envio lê"
  on public.shipping_labels for select to authenticated
  using (private.shipment_org(supplier_order_id, order_id) is not null);

-- ---------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------

/**
 * Registra a etiqueta já enviada ao bucket (a pasta precisa ser a do
 * envio). Avisa o outro lado quando é um pedido de fornecimento.
 */
create function public.register_shipping_label(
  p_supplier_order uuid,
  p_order uuid,
  p_path text,
  p_file_name text,
  p_carrier text,
  p_tracking_code text
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
  v_tracking text := nullif(upper(btrim(coalesce(p_tracking_code, ''))), '');
  v_carrier text := nullif(btrim(coalesce(p_carrier, '')), '');
begin
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
    supplier_order_id, order_id, storage_path, file_name, carrier, tracking_code, uploaded_by, uploaded_org_id
  ) values (
    p_supplier_order, p_order, p_path, left(btrim(coalesce(p_file_name, 'etiqueta')), 120),
    v_carrier, v_tracking, auth.uid(), v_org
  )
  returning id into v_id;

  if p_supplier_order is not null then
    perform private.notify_org(
      case when v_org = v_so.organization_id then v_so.seller_organization_id else v_so.organization_id end,
      '{owner,admin,member}', 'label.attached',
      'Etiqueta anexada ao fornecimento #' || v_so.number,
      coalesce('Rastreio ' || v_tracking || '. ', '') || 'Baixe e imprima para enviar.',
      case when v_org = v_so.organization_id then '/pedidos/' || v_so.order_id else '/fornecimentos/' || v_so.id end
    );
  end if;
  return v_id;
end;
$$;

/** Anula uma etiqueta (errada ou substituída). Quem participa do envio. */
create function public.void_shipping_label(p_label uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_label public.shipping_labels%rowtype;
begin
  select * into v_label from public.shipping_labels l where l.id = p_label for update;
  if v_label.id is null or private.shipment_org(v_label.supplier_order_id, v_label.order_id) is null then
    raise exception 'labels.not_found';
  end if;
  if v_label.voided_at is not null then
    return;
  end if;
  update public.shipping_labels set voided_at = now(), voided_by = auth.uid() where id = p_label;
end;
$$;

grant execute on function public.register_shipping_label(uuid, uuid, text, text, text, text) to authenticated;
grant execute on function public.void_shipping_label(uuid) to authenticated;
