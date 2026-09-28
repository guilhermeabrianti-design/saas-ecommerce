-- =====================================================================
-- Fase 21 · Checkout próprio + Mercado Pago
--
-- O vendedor ativa o checkout num produto importado do catálogo e divulga
-- o link. O comprador (sem conta) paga por PIX, cartão ou boleto; a
-- plataforma recebe pelo Mercado Pago e divide a venda:
--
--   venda − taxa real do Mercado Pago − fornecedor − comissão do vendedor
--   = receita da TheSigns
--
--  * Toda escrita do checkout é feita pela Edge Function `checkout` com o
--    service role; o comprador só consulta o próprio pedido por um token.
--  * O pedido nasce `pending` (aguardando pagamento) no canal `checkout`.
--    Pagamento aprovado confirma o pedido (reserva no fornecedor e pedido
--    de fornecimento) e lança a divisão no livro-razão. Sem estoque (ou
--    valor divergente) na aprovação → o pagamento é estornado.
--  * Preço = preço do produto do vendedor; a comissão (e a regra que a
--    definiu) é congelada no pedido. Preço que não cobre fornecedor +
--    comissão é recusado.
--  * Pedidos do checkout não aceitam as ações manuais de confirmar,
--    cancelar e registrar recebimento/estorno: quem decide é o pagamento.
-- =====================================================================

alter type public.ledger_kind add value if not exists 'checkout_commission';
alter type public.ledger_kind add value if not exists 'checkout_supplier';
alter type public.ledger_kind add value if not exists 'checkout_reversal';

create type public.order_channel as enum ('manual', 'marketplace', 'checkout');
create type public.checkout_payment_status as enum (
  'pending', 'approved', 'rejected', 'cancelled', 'refunded', 'charged_back'
);

-- ---------------------------------------------------------------------
-- Canal do pedido
-- ---------------------------------------------------------------------
alter table public.orders
  add column channel public.order_channel not null default 'manual';

update public.orders o set channel = 'marketplace'
where exists (select 1 from public.external_orders e where e.order_id = o.id);

create function private.external_order_channel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.orders set channel = 'marketplace' where id = new.order_id and channel = 'manual';
  return new;
end;
$$;

create trigger external_orders_set_channel
  after insert on public.external_orders
  for each row execute function private.external_order_channel();

-- Livro-razão: sinais dos novos tipos (comparação por texto: valores de enum
-- recém-criados não podem ser usados como literal na mesma transação).
alter table public.ledger_entries drop constraint ledger_entries_check;
alter table public.ledger_entries add constraint ledger_entries_kind_sign check (
  (kind::text in ('sale_payment', 'supplier_receipt', 'checkout_commission', 'checkout_supplier')
    and amount_cents > 0)
  or (kind::text in ('refund', 'supplier_payment', 'checkout_reversal') and amount_cents < 0)
);

-- ---------------------------------------------------------------------
-- Produto no checkout (só o vendedor liga, pela RPC)
-- ---------------------------------------------------------------------
alter table public.products
  add column checkout_enabled boolean not null default false;

-- ---------------------------------------------------------------------
-- Pagamento do checkout (um por pedido)
-- ---------------------------------------------------------------------
create table public.checkout_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  order_id uuid not null unique references public.orders (id) on delete cascade,
  -- Consulta pública do comprador (não expõe o id do pedido).
  public_token uuid not null unique default gen_random_uuid(),
  provider text not null default 'mercadopago' check (provider = 'mercadopago'),
  external_id text unique check (external_id is null or external_id ~ '^[0-9]{1,30}$'),
  method public.payment_method check (method is null or method in ('pix', 'card', 'boleto')),
  status public.checkout_payment_status not null default 'pending',
  status_detail text check (status_detail is null or char_length(status_detail) <= 120),
  amount_cents bigint not null check (amount_cents between 1 and 100000000000),
  fee_cents bigint check (fee_cents is null or fee_cents between 0 and 100000000000),
  pix_qr_code text check (pix_qr_code is null or char_length(pix_qr_code) <= 1000),
  pix_qr_base64 text check (pix_qr_base64 is null or char_length(pix_qr_base64) <= 60000),
  boleto_url text check (boleto_url is null or (boleto_url ~ '^https://' and char_length(boleto_url) <= 500)),
  expires_at timestamptz,
  -- Aprovado mas sem condição de seguir (sem estoque, pedido cancelado,
  -- valor divergente): precisa ser estornado no Mercado Pago.
  needs_refund boolean not null default false,
  refund_reason text check (refund_reason is null or char_length(refund_reason) <= 120),
  approved_at timestamptz,
  settled_at timestamptz,
  reversed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index checkout_payments_org_idx on public.checkout_payments (organization_id, created_at desc);
create index checkout_payments_created_idx on public.checkout_payments (created_at desc);

create trigger checkout_payments_set_updated_at
  before update on public.checkout_payments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Divisão congelada do pedido
-- ---------------------------------------------------------------------
create table public.order_splits (
  order_id uuid primary key references public.orders (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  listing_id uuid references public.catalog_listings (id) on delete set null,
  sale_cents bigint not null check (sale_cents > 0),
  -- Taxa real do Mercado Pago: conhecida só na aprovação.
  payment_fee_cents bigint check (payment_fee_cents is null or payment_fee_cents >= 0),
  supplier_cents bigint not null check (supplier_cents >= 0),
  seller_commission_bps integer not null check (seller_commission_bps between 0 and 10000),
  seller_commission_source text not null,
  seller_commission_cents bigint not null check (seller_commission_cents >= 0),
  -- Estimativa (sem a taxa) até a aprovação; depois, o valor lançado.
  platform_cents bigint not null,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);

create index order_splits_org_idx on public.order_splits (organization_id);

-- ---------------------------------------------------------------------
-- Livro-razão da plataforma (receita da TheSigns), imutável
-- ---------------------------------------------------------------------
create table public.platform_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('checkout_revenue', 'checkout_reversal')),
  amount_cents bigint not null check (amount_cents <> 0 and abs(amount_cents) <= 100000000000),
  order_id uuid,
  checkout_payment_id uuid,
  description text check (description is null or char_length(description) <= 500),
  request_id uuid not null unique,
  created_at timestamptz not null default now()
);

create index platform_ledger_entries_created_idx on public.platform_ledger_entries (created_at desc);

create trigger platform_ledger_entries_no_update
  before update or delete on public.platform_ledger_entries
  for each row execute function private.ledger_entries_immutable();

create trigger platform_ledger_entries_no_truncate
  before truncate on public.platform_ledger_entries
  for each statement execute function private.ledger_entries_immutable();

-- ---------------------------------------------------------------------
-- Privilégios e RLS
-- ---------------------------------------------------------------------
revoke all on table public.checkout_payments from anon, authenticated;
revoke all on table public.order_splits from anon, authenticated;
revoke all on table public.platform_ledger_entries from anon, authenticated;

-- O vendedor (owner/admin) acompanha pagamento e divisão dos próprios pedidos.
grant select (
  id, organization_id, order_id, method, status, status_detail, amount_cents, fee_cents,
  expires_at, needs_refund, approved_at, settled_at, reversed_at, created_at, updated_at
) on table public.checkout_payments to authenticated;
grant select on table public.order_splits to authenticated;

alter table public.checkout_payments enable row level security;
alter table public.order_splits enable row level security;
alter table public.platform_ledger_entries enable row level security;

create policy "checkout_payments: owner/admin do vendedor leem"
  on public.checkout_payments for select to authenticated
  using (private.has_org_role(organization_id, '{owner,admin}'));

create policy "order_splits: owner/admin do vendedor leem"
  on public.order_splits for select to authenticated
  using (private.has_org_role(organization_id, '{owner,admin}'));

-- ---------------------------------------------------------------------
-- Núcleos de confirmar/cancelar (sem checagem de papel; o chamador valida
-- e já travou o pedido). As RPCs do vendedor passam a usá-los.
-- ---------------------------------------------------------------------

/** Confirma um pedido pendente travado: reservas e pedidos de fornecimento. */
create function private.confirm_order_core(p_order uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  r record;
  v_supplier_org uuid;
  v_supplier_order uuid;
  v_lock uuid[];
begin
  select * into v_order from public.orders o where o.id = p_order;
  if v_order.status <> 'pending' then
    raise exception 'orders.invalid_status';
  end if;

  if exists (
    select 1 from private.order_supplier_sources(p_order) s where s.supplier_item is null
  ) then
    raise exception 'orders.source_unavailable';
  end if;

  select array_agg(x order by x) into v_lock from (
    select oi.inventory_item_id as x from public.order_items oi
    where oi.order_id = p_order and oi.fulfillment = 'own_stock'
    union
    select s.supplier_item from private.order_supplier_sources(p_order) s
  ) t;
  perform private.lock_inventory_items(coalesce(v_lock, '{}'));

  for r in
    select oi.inventory_item_id, sum(oi.quantity)::integer as qty from public.order_items oi
    where oi.order_id = p_order and oi.fulfillment = 'own_stock'
    group by oi.inventory_item_id
  loop
    perform private.reserve_stock(r.inventory_item_id, r.qty);
  end loop;

  for r in select s.supplier_item, sum(s.quantity)::integer as qty
    from private.order_supplier_sources(p_order) s group by s.supplier_item
  loop
    perform private.reserve_stock(r.supplier_item, r.qty);
  end loop;

  for v_supplier_org in select distinct s.supplier_org from private.order_supplier_sources(p_order) s loop
    insert into public.supplier_orders (
      organization_id, seller_organization_id, order_id, number,
      recipient_name, recipient_phone, recipient_document,
      ship_postal_code, ship_street, ship_number, ship_complement, ship_district, ship_city, ship_state,
      total_wholesale_cents
    ) values (
      v_supplier_org, v_order.organization_id, p_order, private.next_order_number(v_supplier_org),
      v_order.customer_name, v_order.customer_phone, v_order.customer_document,
      v_order.ship_postal_code, v_order.ship_street, v_order.ship_number, v_order.ship_complement,
      v_order.ship_district, v_order.ship_city, v_order.ship_state,
      (select sum(s.quantity * s.wholesale) from private.order_supplier_sources(p_order) s
        where s.supplier_org = v_supplier_org)
    )
    returning id into v_supplier_order;

    insert into public.supplier_order_items (
      supplier_order_id, order_item_id, inventory_item_id, sku, name, attributes,
      quantity, unit_wholesale_cents
    )
    select v_supplier_order, s.order_item_id, s.supplier_item, s.sku, s.name, s.attributes,
      s.quantity, s.wholesale
    from private.order_supplier_sources(p_order) s where s.supplier_org = v_supplier_org;
  end loop;

  update public.orders set status = 'confirmed', confirmed_at = now() where id = p_order;
end;
$$;

/** Cancela um pedido travado antes do envio: libera reservas próprias e do fornecedor. */
create function private.cancel_order_core(p_order uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  r record;
  v_lock uuid[];
begin
  select * into v_order from public.orders o where o.id = p_order;
  if v_order.status not in ('pending', 'confirmed') then
    raise exception 'orders.invalid_status';
  end if;

  perform 1 from public.supplier_orders so where so.order_id = p_order order by so.id for update;
  if exists (
    select 1 from public.supplier_orders so where so.order_id = p_order and so.status = 'shipped'
  ) then
    raise exception 'orders.supplier_already_shipped';
  end if;

  if v_order.status = 'confirmed' then
    select array_agg(x order by x) into v_lock from (
      select oi.inventory_item_id as x from public.order_items oi
      where oi.order_id = p_order and oi.fulfillment = 'own_stock'
      union
      select soi.inventory_item_id from public.supplier_order_items soi
      join public.supplier_orders so on so.id = soi.supplier_order_id
      where so.order_id = p_order
    ) t;
    perform private.lock_inventory_items(coalesce(v_lock, '{}'));

    for r in select oi.inventory_item_id, oi.quantity from public.order_items oi
      where oi.order_id = p_order and oi.fulfillment = 'own_stock'
    loop
      perform private.release_stock(r.inventory_item_id, r.quantity);
    end loop;
    for r in select soi.inventory_item_id, soi.quantity from public.supplier_order_items soi
      join public.supplier_orders so on so.id = soi.supplier_order_id
      where so.order_id = p_order
    loop
      perform private.release_stock(r.inventory_item_id, r.quantity);
    end loop;
  end if;

  update public.supplier_orders set status = 'cancelled', cancelled_at = now()
  where order_id = p_order;
  update public.orders set status = 'cancelled', cancelled_at = now() where id = p_order;
end;
$$;

create or replace function public.confirm_order(p_order uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype := private.lock_order_for(p_order, '{owner,admin}');
begin
  if v_order.channel = 'checkout' then
    raise exception 'orders.checkout_managed';
  end if;
  perform private.confirm_order_core(p_order);
end;
$$;

create or replace function public.cancel_order(p_order uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype := private.lock_order_for(p_order, '{owner,admin}');
begin
  if v_order.channel = 'checkout' then
    raise exception 'orders.checkout_managed';
  end if;
  perform private.cancel_order_core(p_order);
end;
$$;

-- Recebimento/estorno manual: não vale para pedidos do checkout.
create or replace function public.record_order_payment(
  p_order uuid,
  p_amount_cents bigint,
  p_method public.payment_method,
  p_note text,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype := private.lock_order_for(p_order, '{owner,admin}');
  v_existing uuid;
  v_id uuid;
begin
  if v_order.channel = 'checkout' then
    raise exception 'orders.checkout_managed';
  end if;
  if p_request_id is null or p_amount_cents is null or p_amount_cents < 1 then
    raise exception 'finance.invalid';
  end if;

  select pay.id into v_existing from public.order_payments pay
  where pay.organization_id = v_order.organization_id and pay.request_id = p_request_id;
  if found then
    return v_existing;
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'finance.order_cancelled';
  end if;
  if v_order.paid_cents - v_order.refunded_cents + p_amount_cents > v_order.total_cents then
    raise exception 'finance.overpayment';
  end if;

  insert into public.order_payments (
    organization_id, order_id, kind, method, amount_cents, note, request_id, created_by
  ) values (
    v_order.organization_id, p_order, 'payment', p_method, p_amount_cents,
    nullif(btrim(p_note), ''), p_request_id, auth.uid()
  )
  returning id into v_id;

  insert into public.ledger_entries (
    organization_id, kind, amount_cents, order_id, description, created_by, request_id
  ) values (
    v_order.organization_id, 'sale_payment', p_amount_cents, p_order,
    'Recebimento do pedido #' || v_order.number, auth.uid(), v_id
  );

  update public.orders set paid_cents = paid_cents + p_amount_cents where id = p_order;
  return v_id;
end;
$$;

create or replace function public.refund_order_payment(
  p_order uuid,
  p_amount_cents bigint,
  p_method public.payment_method,
  p_note text,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype := private.lock_order_for(p_order, '{owner,admin}');
  v_existing uuid;
  v_id uuid;
begin
  if v_order.channel = 'checkout' then
    raise exception 'orders.checkout_managed';
  end if;
  if p_request_id is null or p_amount_cents is null or p_amount_cents < 1 then
    raise exception 'finance.invalid';
  end if;

  select pay.id into v_existing from public.order_payments pay
  where pay.organization_id = v_order.organization_id and pay.request_id = p_request_id;
  if found then
    return v_existing;
  end if;

  if p_amount_cents > v_order.paid_cents - v_order.refunded_cents then
    raise exception 'finance.refund_exceeds';
  end if;

  insert into public.order_payments (
    organization_id, order_id, kind, method, amount_cents, note, request_id, created_by
  ) values (
    v_order.organization_id, p_order, 'refund', p_method, p_amount_cents,
    nullif(btrim(p_note), ''), p_request_id, auth.uid()
  )
  returning id into v_id;

  insert into public.ledger_entries (
    organization_id, kind, amount_cents, order_id, description, created_by, request_id
  ) values (
    v_order.organization_id, 'refund', -p_amount_cents, p_order,
    'Estorno do pedido #' || v_order.number, auth.uid(), v_id
  );

  update public.orders set refunded_cents = refunded_cents + p_amount_cents where id = p_order;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Elegibilidade e cotação
-- ---------------------------------------------------------------------

/**
 * Motivo pelo qual o produto não pode ser vendido pelo checkout (nulo = pode).
 * Não olha `checkout_enabled`: serve também para o vendedor antes de ligar.
 */
create function private.checkout_block_reason(p_product uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_product public.products%rowtype;
  v_org public.organizations%rowtype;
begin
  select * into v_product from public.products p where p.id = p_product;
  if v_product.id is null then
    return 'not_found';
  end if;
  select * into v_org from public.organizations o where o.id = v_product.organization_id;
  if v_org.kind <> 'seller' or v_org.suspended_at is not null then
    return 'seller_unavailable';
  end if;
  if v_product.source_listing_id is null then
    return 'not_imported';
  end if;
  if v_product.status <> 'active' then
    return 'inactive';
  end if;
  if not private.visible_listing(v_product.source_listing_id) then
    return 'listing_unavailable';
  end if;
  return null;
end;
$$;

/**
 * Cotação unitária de uma variação (ou do produto sem variações): preço do
 * vendedor, atacado atual, comissão e o que sobra para a plataforma antes
 * da taxa do Mercado Pago.
 */
create function private.checkout_quote(p_product uuid, p_variant uuid, p_quantity integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_product public.products%rowtype;
  v_variant public.product_variants%rowtype;
  v_listing public.catalog_listings%rowtype;
  v_price bigint;
  v_wholesale bigint;
  v_bps integer;
  v_source text;
  v_sale bigint;
  v_supplier bigint;
  v_commission bigint;
begin
  select * into v_product from public.products p where p.id = p_product;
  select * into v_listing from public.catalog_listings l where l.id = v_product.source_listing_id;
  if p_variant is not null then
    select * into v_variant from public.product_variants v
    where v.id = p_variant and v.product_id = p_product;
    if v_variant.id is null then
      raise exception 'checkout.invalid';
    end if;
  end if;

  v_price := coalesce(v_variant.price_cents, v_product.price_cents);
  v_wholesale := v_listing.wholesale_price_cents;
  select s.percent_bps, s.source into v_bps, v_source
  from private.seller_commission(v_listing.id, v_listing.category_id, v_product.organization_id, null) s;
  if v_bps is null then
    raise exception 'fees.commission_not_configured';
  end if;

  v_sale := v_price * p_quantity;
  v_supplier := v_wholesale * p_quantity;
  v_commission := private.percent_of(v_sale, v_bps);

  return jsonb_build_object(
    'unit_price_cents', v_price,
    'quantity', p_quantity,
    'sale_cents', v_sale,
    'supplier_cents', v_supplier,
    'seller_commission_bps', v_bps,
    'seller_commission_source', v_source,
    'seller_commission_cents', v_commission,
    'platform_before_fee_cents', v_sale - v_supplier - v_commission
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Vendedor
-- ---------------------------------------------------------------------

/** Situação do checkout de um produto (membros da organização). */
create function public.checkout_product_summary(p_product uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_product public.products%rowtype;
  v_reason text;
  v_variant uuid;
  v_quote jsonb;
begin
  select * into v_product from public.products p where p.id = p_product;
  if v_product.id is null or not private.is_org_member(v_product.organization_id) then
    raise exception 'checkout.not_found';
  end if;

  v_reason := private.checkout_block_reason(p_product);
  if v_reason is null then
    -- Produto com variações: cota a variação ativa mais barata.
    select v.id into v_variant from public.product_variants v
    where v.product_id = p_product and v.is_active
    order by coalesce(v.price_cents, v_product.price_cents), v.id limit 1;
    if v_variant is null and exists (
      select 1 from public.product_variants v where v.product_id = p_product
    ) then
      v_reason := 'inactive';
    end if;
  end if;
  if v_reason is null then
    begin
      v_quote := private.checkout_quote(p_product, v_variant, 1);
      if (v_quote ->> 'platform_before_fee_cents')::bigint < 0 then
        v_reason := 'price_below_cost';
      end if;
    exception when others then
      if sqlerrm = 'fees.commission_not_configured' then
        v_reason := 'commission_not_configured';
      else
        raise;
      end if;
    end;
  end if;

  return jsonb_build_object(
    'enabled', v_product.checkout_enabled,
    'block_reason', v_reason,
    'quote', v_quote
  );
end;
$$;

/** Liga/desliga o checkout de um produto importado (owner/admin do vendedor). */
create function public.set_product_checkout(p_product uuid, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products%rowtype;
begin
  select * into v_product from public.products p where p.id = p_product for update;
  if v_product.id is null or not private.has_org_role(v_product.organization_id, '{owner,admin}') then
    raise exception 'checkout.not_found';
  end if;
  if p_enabled and private.checkout_block_reason(p_product) is not null then
    raise exception 'checkout.not_eligible';
  end if;
  update public.products set checkout_enabled = coalesce(p_enabled, false) where id = p_product;
end;
$$;

-- ---------------------------------------------------------------------
-- Checkout público (somente service role, via Edge Function)
-- ---------------------------------------------------------------------

/** Oferta pública do produto. Nulo quando indisponível. */
create function public.checkout_offer(p_product uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_product public.products%rowtype;
  v_listing public.catalog_listings%rowtype;
  v_source public.products%rowtype;
begin
  select * into v_product from public.products p where p.id = p_product;
  if v_product.id is null or not v_product.checkout_enabled
     or private.checkout_block_reason(p_product) is not null then
    return null;
  end if;
  select * into v_listing from public.catalog_listings l where l.id = v_product.source_listing_id;
  select * into v_source from public.products p where p.id = v_listing.product_id;

  return jsonb_build_object(
    'product_id', v_product.id,
    'name', v_product.name,
    'description', v_product.description,
    'brand', v_product.brand,
    'store_name', (select o.name from public.organizations o where o.id = v_product.organization_id),
    'price_cents', v_product.price_cents,
    'has_variants', exists (select 1 from public.product_variants v where v.product_id = v_product.id),
    -- Disponível = saldo livre do fornecedor (a venda sai do estoque dele).
    'available', (
      select greatest(si.on_hand - si.reserved, 0)
      from public.inventory_items si
      where si.product_id = v_source.id and si.variant_id is null
    ),
    'variants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'variant_id', v.id,
        'attributes', v.attributes,
        'price_cents', coalesce(v.price_cents, v_product.price_cents),
        'available', coalesce((
          select greatest(si.on_hand - si.reserved, 0) from public.inventory_items si
          where si.variant_id = v.source_variant_id
        ), 0)
      ) order by coalesce(v.price_cents, v_product.price_cents), v.sku)
      from public.product_variants v
      where v.product_id = v_product.id and v.is_active and v.source_variant_id is not null
    ), '[]'::jsonb),
    -- Fotos do produto do vendedor (copiadas na importação); sem nenhuma, as
    -- do fornecedor. A Edge Function assina as URLs.
    'image_paths', coalesce(
      (select jsonb_agg(i.storage_path order by i.position)
       from public.product_images i where i.product_id = v_product.id),
      (select jsonb_agg(i.storage_path order by i.position)
       from public.product_images i where i.product_id = v_source.id),
      '[]'::jsonb)
  );
end;
$$;

/**
 * Cria o pedido do checkout (aguardando pagamento), congela a divisão e
 * abre o registro de pagamento. Idempotente por p_request_id.
 * p_customer: customer_name, customer_email, customer_phone,
 * customer_document e ship_* (mesmas regras do pedido).
 */
create function public.checkout_create_order(
  p_product uuid,
  p_variant uuid,
  p_quantity integer,
  p_customer jsonb,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products%rowtype;
  v_org uuid;
  v_item uuid;
  v_order uuid;
  v_row public.orders%rowtype;
  v_pay public.checkout_payments%rowtype;
  v_quote jsonb;
  v_supplier bigint;
begin
  if p_request_id is null or p_quantity is null or p_quantity not between 1 and 10
     or jsonb_typeof(p_customer) <> 'object' then
    raise exception 'checkout.invalid';
  end if;

  select * into v_product from public.products p where p.id = p_product;
  v_org := v_product.organization_id;

  -- Repetição da mesma tentativa: devolve o que já existe.
  select o.id into v_order from public.orders o
  where o.organization_id = v_org and o.request_id = p_request_id;
  if v_order is null then
    if v_product.id is null or not v_product.checkout_enabled
       or private.checkout_block_reason(p_product) is not null then
      raise exception 'checkout.unavailable';
    end if;
    if p_variant is null and exists (
      select 1 from public.product_variants v where v.product_id = p_product
    ) then
      raise exception 'checkout.invalid';
    end if;

    select i.id into v_item from public.inventory_items i
    where i.product_id = p_product and i.variant_id is not distinct from p_variant;
    if v_item is null then
      raise exception 'checkout.invalid';
    end if;

    -- Tentativas que nunca viraram pagamento (falha de rede) expiram em 1 hora.
    update public.orders o set status = 'cancelled', cancelled_at = now()
    where o.organization_id = v_org and o.channel = 'checkout' and o.status = 'pending'
      and o.created_at < now() - interval '1 hour'
      and exists (
        select 1 from public.checkout_payments c where c.order_id = o.id and c.external_id is null
      );

    -- Freio contra pedidos em massa sem pagamento (rate limit completo na Fase 26).
    if (
      select count(*) from public.orders o
      where o.organization_id = v_org and o.channel = 'checkout' and o.status = 'pending'
        and o.created_at > now() - interval '1 hour'
    ) >= 100 then
      raise exception 'checkout.rate_limited';
    end if;

    v_order := private.create_order_core(
      v_org,
      jsonb_build_object(
        'customer_name', p_customer ->> 'customer_name',
        'customer_email', p_customer ->> 'customer_email',
        'customer_phone', p_customer ->> 'customer_phone',
        'customer_document', p_customer ->> 'customer_document',
        'ship_postal_code', p_customer ->> 'ship_postal_code',
        'ship_street', p_customer ->> 'ship_street',
        'ship_number', p_customer ->> 'ship_number',
        'ship_complement', p_customer ->> 'ship_complement',
        'ship_district', p_customer ->> 'ship_district',
        'ship_city', p_customer ->> 'ship_city',
        'ship_state', p_customer ->> 'ship_state',
        'items', jsonb_build_array(jsonb_build_object('inventory_item_id', v_item, 'quantity', p_quantity))
      ),
      p_request_id,
      null
    );
    update public.orders set channel = 'checkout' where id = v_order;

    if exists (
      select 1 from private.order_supplier_sources(v_order) s where s.supplier_item is null
    ) then
      raise exception 'orders.source_unavailable';
    end if;
    if exists (
      select 1 from private.order_supplier_sources(v_order) s
      join public.inventory_items si on si.id = s.supplier_item
      where si.on_hand - si.reserved < s.quantity
    ) then
      raise exception 'orders.insufficient_stock';
    end if;

    v_quote := private.checkout_quote(p_product, p_variant, p_quantity);
    select sum(s.quantity * s.wholesale) into v_supplier from private.order_supplier_sources(v_order) s;
    if (v_quote ->> 'sale_cents')::bigint - v_supplier
       - (v_quote ->> 'seller_commission_cents')::bigint < 0 then
      raise exception 'checkout.price_below_cost';
    end if;

    insert into public.order_splits (
      order_id, organization_id, listing_id, sale_cents, supplier_cents,
      seller_commission_bps, seller_commission_source, seller_commission_cents, platform_cents
    ) values (
      v_order, v_org, v_product.source_listing_id, (v_quote ->> 'sale_cents')::bigint, v_supplier,
      (v_quote ->> 'seller_commission_bps')::integer, v_quote ->> 'seller_commission_source',
      (v_quote ->> 'seller_commission_cents')::bigint,
      (v_quote ->> 'sale_cents')::bigint - v_supplier - (v_quote ->> 'seller_commission_cents')::bigint
    );

    insert into public.checkout_payments (organization_id, order_id, amount_cents)
    select v_org, v_order, o.total_cents from public.orders o where o.id = v_order;
  end if;

  select * into v_row from public.orders o where o.id = v_order;
  select * into v_pay from public.checkout_payments c where c.order_id = v_order;
  if v_pay.id is null then
    -- request_id de um pedido que não é do checkout.
    raise exception 'checkout.invalid';
  end if;

  return jsonb_build_object(
    'order_id', v_row.id,
    'order_number', v_row.number,
    'total_cents', v_row.total_cents,
    'token', v_pay.public_token,
    'external_id', v_pay.external_id,
    'status', v_pay.status,
    'description', (select oi.name from public.order_items oi where oi.order_id = v_row.id limit 1),
    'store_name', (select o.name from public.organizations o where o.id = v_row.organization_id)
  );
end;
$$;

/** Lança a divisão de um pagamento aprovado (pedido já confirmado e travado). */
create function private.checkout_settle(p_payment uuid, p_fee_cents bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay public.checkout_payments%rowtype;
  v_order public.orders%rowtype;
  v_split public.order_splits%rowtype;
  v_supplier bigint;
  v_platform bigint;
  so record;
begin
  select * into v_pay from public.checkout_payments c where c.id = p_payment;
  select * into v_order from public.orders o where o.id = v_pay.order_id;
  select * into v_split from public.order_splits s where s.order_id = v_pay.order_id for update;

  -- Atacado efetivo = o dos pedidos de fornecimento criados na confirmação.
  select coalesce(sum(x.total_wholesale_cents), 0) into v_supplier
  from public.supplier_orders x where x.order_id = v_order.id;
  v_platform := v_pay.amount_cents - p_fee_cents - v_supplier - v_split.seller_commission_cents;

  insert into public.order_payments (
    organization_id, order_id, kind, method, amount_cents, note, request_id
  ) values (
    v_order.organization_id, v_order.id, 'payment', v_pay.method, v_pay.amount_cents,
    'Checkout · Mercado Pago ' || v_pay.external_id, v_pay.id
  );
  update public.orders set paid_cents = paid_cents + v_pay.amount_cents where id = v_order.id;

  if v_split.seller_commission_cents > 0 then
    insert into public.ledger_entries (organization_id, kind, amount_cents, order_id, description, request_id)
    values (v_order.organization_id, 'checkout_commission', v_split.seller_commission_cents, v_order.id,
      'Comissão do checkout — pedido #' || v_order.number, v_pay.id);
  end if;

  for so in select * from public.supplier_orders x where x.order_id = v_order.id order by x.id loop
    if so.total_wholesale_cents > 0 then
      insert into public.ledger_entries (
        organization_id, kind, amount_cents, order_id, supplier_order_id, description, request_id
      ) values (
        so.organization_id, 'checkout_supplier', so.total_wholesale_cents, v_order.id, so.id,
        'Venda pelo checkout — fornecimento #' || so.number, so.id
      );
    end if;
  end loop;
  -- A plataforma acerta com o fornecedor: nada a pagar pelo vendedor.
  update public.supplier_orders set paid_at = now() where order_id = v_order.id;

  if v_platform <> 0 then
    insert into public.platform_ledger_entries (kind, amount_cents, order_id, checkout_payment_id, description, request_id)
    values ('checkout_revenue', v_platform, v_order.id, v_pay.id,
      'Receita do checkout — pedido #' || v_order.number, v_pay.id);
  end if;

  update public.order_splits
  set payment_fee_cents = p_fee_cents, supplier_cents = v_supplier, platform_cents = v_platform,
      settled_at = now()
  where order_id = v_order.id;
  update public.checkout_payments set settled_at = now() where id = v_pay.id;
end;
$$;

/**
 * Desfaz a divisão de um pagamento estornado/contestado. Comissão e receita
 * voltam; o fornecedor só devolve o que não chegou a enviar — envio feito
 * fica com ele e a perda é da plataforma.
 */
create function private.checkout_reverse(p_payment uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay public.checkout_payments%rowtype;
  v_order public.orders%rowtype;
  v_split public.order_splits%rowtype;
  v_kept bigint := 0;
  v_platform bigint;
  so record;
begin
  select * into v_pay from public.checkout_payments c where c.id = p_payment;
  select * into v_order from public.orders o where o.id = v_pay.order_id;
  select * into v_split from public.order_splits s where s.order_id = v_pay.order_id;

  insert into public.order_payments (
    organization_id, order_id, kind, method, amount_cents, note, request_id
  ) values (
    v_order.organization_id, v_order.id, 'refund', v_pay.method, v_pay.amount_cents,
    'Checkout · estorno Mercado Pago ' || v_pay.external_id,
    md5(v_pay.id::text || ':reversal')::uuid
  );
  update public.orders set refunded_cents = refunded_cents + v_pay.amount_cents where id = v_order.id;

  if v_split.seller_commission_cents > 0 then
    insert into public.ledger_entries (organization_id, kind, amount_cents, order_id, description, request_id)
    values (v_order.organization_id, 'checkout_reversal', -v_split.seller_commission_cents, v_order.id,
      'Estorno do checkout — pedido #' || v_order.number, md5(v_pay.id::text || ':reversal')::uuid);
  end if;

  for so in select * from public.supplier_orders x where x.order_id = v_order.id order by x.id loop
    if so.total_wholesale_cents = 0 then
      continue;
    end if;
    if so.status = 'shipped' then
      v_kept := v_kept + so.total_wholesale_cents;
    else
      insert into public.ledger_entries (
        organization_id, kind, amount_cents, order_id, supplier_order_id, description, request_id
      ) values (
        so.organization_id, 'checkout_reversal', -so.total_wholesale_cents, v_order.id, so.id,
        'Estorno do checkout — fornecimento #' || so.number, md5(so.id::text || ':reversal')::uuid
      );
    end if;
  end loop;

  v_platform := -(v_split.platform_cents + v_kept);
  if v_platform <> 0 then
    insert into public.platform_ledger_entries (kind, amount_cents, order_id, checkout_payment_id, description, request_id)
    values ('checkout_reversal', v_platform, v_order.id, v_pay.id,
      'Estorno do checkout — pedido #' || v_order.number, md5(v_pay.id::text || ':reversal')::uuid);
  end if;

  update public.checkout_payments set reversed_at = now() where id = v_pay.id;
end;
$$;

/**
 * Aplica o estado de um pagamento do Mercado Pago (já consultado na API).
 * p_payment: external_id, external_reference (id do pedido), status,
 * status_detail, method, amount_cents, fee_cents, pix_qr_code,
 * pix_qr_base64, boleto_url, expires_at.
 *
 * Devolve: pending | confirmed | cancelled | reversed | refund_required |
 * unchanged. `refund_required` = estornar no Mercado Pago.
 */
create function public.checkout_sync_payment(p_payment jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_external text := p_payment ->> 'external_id';
  v_status public.checkout_payment_status := (p_payment ->> 'status')::public.checkout_payment_status;
  v_pay public.checkout_payments%rowtype;
  v_order public.orders%rowtype;
  v_amount bigint := (p_payment ->> 'amount_cents')::bigint;
  v_fee bigint := coalesce((p_payment ->> 'fee_cents')::bigint, 0);
  v_problem text;
begin
  if v_external is null or v_external !~ '^[0-9]{1,30}$' or v_status is null or v_amount is null then
    raise exception 'checkout.invalid';
  end if;

  select c.* into v_pay from public.checkout_payments c where c.external_id = v_external;
  if v_pay.id is null then
    -- Primeiro contato: vincula ao pedido indicado na referência externa.
    select c.* into v_pay from public.checkout_payments c
    where c.order_id = (p_payment ->> 'external_reference')::uuid and c.external_id is null;
    if v_pay.id is null then
      raise exception 'checkout.payment_not_found';
    end if;
  end if;

  -- Ordem de travas das RPCs de pedido: pedido → pagamento.
  select * into v_order from public.orders o where o.id = v_pay.order_id for update;
  select * into v_pay from public.checkout_payments c where c.id = v_pay.id for update;

  update public.checkout_payments set
    external_id = v_external,
    method = coalesce((p_payment ->> 'method')::public.payment_method, method),
    status = v_status,
    status_detail = left(p_payment ->> 'status_detail', 120),
    fee_cents = coalesce((p_payment ->> 'fee_cents')::bigint, fee_cents),
    pix_qr_code = coalesce(p_payment ->> 'pix_qr_code', pix_qr_code),
    pix_qr_base64 = coalesce(p_payment ->> 'pix_qr_base64', pix_qr_base64),
    boleto_url = coalesce(p_payment ->> 'boleto_url', boleto_url),
    expires_at = coalesce((p_payment ->> 'expires_at')::timestamptz, expires_at),
    approved_at = case when v_status = 'approved' then coalesce(approved_at, now()) else approved_at end
  where id = v_pay.id;

  if v_status = 'approved' then
    if v_pay.settled_at is not null then
      return 'unchanged';
    end if;
    if v_pay.needs_refund then
      return 'refund_required';
    end if;

    if v_amount <> v_pay.amount_cents then
      v_problem := 'amount_mismatch';
    elsif v_order.status <> 'pending' then
      v_problem := 'order_not_pending';
    else
      begin
        perform private.confirm_order_core(v_order.id);
      exception when others then
        if sqlerrm not like 'orders.%' then
          raise;
        end if;
        v_problem := sqlerrm;
      end;
    end if;

    if v_problem is not null then
      update public.checkout_payments set needs_refund = true, refund_reason = left(v_problem, 120)
      where id = v_pay.id;
      if v_order.status = 'pending' then
        update public.orders set status = 'cancelled', cancelled_at = now() where id = v_order.id;
      end if;
      return 'refund_required';
    end if;

    perform private.checkout_settle(v_pay.id, v_fee);
    return 'confirmed';
  end if;

  if v_status in ('rejected', 'cancelled') then
    if v_order.status = 'pending' then
      -- Nada foi reservado antes da aprovação.
      update public.orders set status = 'cancelled', cancelled_at = now() where id = v_order.id;
      return 'cancelled';
    end if;
    return 'unchanged';
  end if;

  if v_status in ('refunded', 'charged_back') then
    update public.checkout_payments set needs_refund = false where id = v_pay.id;
    if v_pay.settled_at is null or v_pay.reversed_at is not null then
      if v_order.status = 'pending' then
        update public.orders set status = 'cancelled', cancelled_at = now() where id = v_order.id;
      end if;
      return 'unchanged';
    end if;
    if v_order.status in ('pending', 'confirmed') and not exists (
      select 1 from public.supplier_orders so where so.order_id = v_order.id and so.status = 'shipped'
    ) then
      perform private.cancel_order_core(v_order.id);
    end if;
    perform private.checkout_reverse(v_pay.id);
    return 'reversed';
  end if;

  return 'pending';
end;
$$;

/** O Mercado Pago recusou criar o pagamento (dados do cartão, etc.): cancela a tentativa. */
create function public.checkout_abandon(p_order uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.orders o where o.id = p_order for update;
  update public.orders o set status = 'cancelled', cancelled_at = now()
  where o.id = p_order and o.channel = 'checkout' and o.status = 'pending'
    and exists (
      select 1 from public.checkout_payments c where c.order_id = o.id and c.external_id is null
    );
end;
$$;

/** Situação do pedido para o comprador (pelo token do link de acompanhamento). */
create function public.checkout_order_status(p_token uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'order_number', o.number,
    'store_name', org.name,
    'product_name', (select oi.name from public.order_items oi where oi.order_id = o.id limit 1),
    'total_cents', o.total_cents,
    'payment_status', c.status,
    'order_status', o.status,
    'method', c.method,
    'pix_qr_code', case when c.status = 'pending' then c.pix_qr_code end,
    'pix_qr_base64', case when c.status = 'pending' then c.pix_qr_base64 end,
    'boleto_url', case when c.status = 'pending' then c.boleto_url end,
    'expires_at', c.expires_at,
    'refund_pending', c.needs_refund,
    'tracking', (
      select jsonb_agg(jsonb_build_object('carrier', so.carrier, 'code', so.tracking_code))
      from public.supplier_orders so
      where so.order_id = o.id and so.tracking_code is not null
    )
  )
  from public.checkout_payments c
  join public.orders o on o.id = c.order_id
  join public.organizations org on org.id = o.organization_id
  where c.public_token = p_token
$$;

-- ---------------------------------------------------------------------
-- Equipe
-- ---------------------------------------------------------------------

create function public.admin_checkout_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'approved_cents', (select coalesce(sum(c.amount_cents), 0) from public.checkout_payments c
                       where c.settled_at is not null and c.reversed_at is null),
    'fees_cents', (select coalesce(sum(s.payment_fee_cents), 0) from public.order_splits s
                   join public.checkout_payments c on c.order_id = s.order_id
                   where s.settled_at is not null and c.reversed_at is null),
    'supplier_cents', (select coalesce(sum(s.supplier_cents), 0) from public.order_splits s
                       join public.checkout_payments c on c.order_id = s.order_id
                       where s.settled_at is not null and c.reversed_at is null),
    'commission_cents', (select coalesce(sum(s.seller_commission_cents), 0) from public.order_splits s
                         join public.checkout_payments c on c.order_id = s.order_id
                         where s.settled_at is not null and c.reversed_at is null),
    'platform_cents', (select coalesce(sum(e.amount_cents), 0) from public.platform_ledger_entries e),
    'needs_refund', (select count(*) from public.checkout_payments c where c.needs_refund)
  );
end;
$$;

/** Pagamentos do checkout, mais recentes primeiro. p_filter: all | needs_refund | approved. */
create function public.admin_checkout_payments(p_filter text, p_limit integer, p_offset integer)
returns table (
  order_id uuid,
  order_number bigint,
  store_name text,
  external_id text,
  method public.payment_method,
  status public.checkout_payment_status,
  status_detail text,
  amount_cents bigint,
  fee_cents bigint,
  supplier_cents bigint,
  commission_cents bigint,
  platform_cents bigint,
  needs_refund boolean,
  refund_reason text,
  refundable boolean,
  created_at timestamptz,
  approved_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return query
    select c.order_id, o.number, org.name, c.external_id, c.method, c.status, c.status_detail,
      c.amount_cents, s.payment_fee_cents, s.supplier_cents, s.seller_commission_cents, s.platform_cents,
      c.needs_refund, c.refund_reason,
      (c.status = 'approved' and c.external_id is not null and (
        c.needs_refund or (c.settled_at is not null and c.reversed_at is null and not exists (
          select 1 from public.supplier_orders so where so.order_id = o.id and so.status = 'shipped'))
      )) as refundable,
      c.created_at, c.approved_at
    from public.checkout_payments c
    join public.orders o on o.id = c.order_id
    join public.organizations org on org.id = o.organization_id
    left join public.order_splits s on s.order_id = c.order_id
    where c.external_id is not null
      and (coalesce(p_filter, 'all') = 'all'
        or (p_filter = 'needs_refund' and c.needs_refund)
        or (p_filter = 'approved' and c.status = 'approved'))
    order by c.created_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

/**
 * A equipe pede o estorno total de um pagamento aprovado (antes de qualquer
 * envio do fornecedor, ou já marcado para estorno). Registra na auditoria e
 * devolve o id do pagamento; a Edge Function chama o Mercado Pago.
 */
create function public.admin_checkout_refund_begin(p_order uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay public.checkout_payments%rowtype;
  v_order public.orders%rowtype;
begin
  perform private.require_platform_admin();
  select * into v_order from public.orders o where o.id = p_order for update;
  select * into v_pay from public.checkout_payments c where c.order_id = p_order for update;
  if v_pay.id is null or v_pay.external_id is null then
    raise exception 'checkout.not_found';
  end if;
  if v_pay.status <> 'approved' or not (
    v_pay.needs_refund or (v_pay.settled_at is not null and v_pay.reversed_at is null)
  ) then
    raise exception 'checkout.not_refundable';
  end if;
  if exists (
    select 1 from public.supplier_orders so where so.order_id = p_order and so.status = 'shipped'
  ) then
    raise exception 'checkout.already_shipped';
  end if;

  perform private.audit(
    'checkout.refund', v_order.organization_id,
    'Estorno do pedido #' || v_order.number,
    jsonb_build_object('order_id', p_order, 'external_id', v_pay.external_id, 'amount_cents', v_pay.amount_cents)
  );
  return v_pay.external_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function private.external_order_channel() from public, anon, authenticated;

grant execute on function public.checkout_product_summary(uuid) to authenticated;
grant execute on function public.set_product_checkout(uuid, boolean) to authenticated;
grant execute on function public.admin_checkout_summary() to authenticated;
grant execute on function public.admin_checkout_payments(text, integer, integer) to authenticated;
grant execute on function public.admin_checkout_refund_begin(uuid) to authenticated;

-- O comprador não tem conta: a consulta vai pelo token (uuid aleatório).
grant execute on function public.checkout_order_status(uuid) to anon, authenticated;

grant execute on function public.checkout_offer(uuid) to service_role;
grant execute on function public.checkout_create_order(uuid, uuid, integer, jsonb, uuid) to service_role;
grant execute on function public.checkout_sync_payment(jsonb) to service_role;
grant execute on function public.checkout_abandon(uuid) to service_role;
