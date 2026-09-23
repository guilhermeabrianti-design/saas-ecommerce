-- =====================================================================
-- Fase 8 · Pedidos e encaminhamento ao fornecedor
--
-- Pedido do vendedor (manual por enquanto; marketplaces nas fases de
-- integração). Ciclo: pending → confirmed → shipped → delivered, ou
-- cancelled (antes do envio).
--
--  * Itens guardam snapshot de SKU/nome/atributos/preço.
--  * Itens de estoque próprio: confirmar reserva, enviar baixa (livro-razão
--    `sale`), cancelar libera.
--  * Itens importados do catálogo (Fase 7): confirmar cria um pedido de
--    fornecimento por fornecedor, com atacado congelado e reserva no
--    estoque do fornecedor; o fornecedor envia e informa rastreio.
--  * Fornecedor recebe só os dados de entrega necessários.
--  * Toda escrita é por RPC; linhas de estoque são travadas em ordem de id.
-- =====================================================================

alter type public.inventory_reason add value if not exists 'sale';

create type public.order_status as enum ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled');
create type public.fulfillment_mode as enum ('own_stock', 'supplier');
create type public.supplier_order_status as enum ('pending', 'shipped', 'cancelled');

-- Numeração sequencial por organização (pedidos do vendedor e pedidos de
-- fornecimento do fornecedor usam o contador da própria organização).
create table public.order_counters (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  last_number bigint not null default 0
);
alter table public.order_counters enable row level security;
revoke all on table public.order_counters from anon, authenticated;

create function private.next_order_number(p_org uuid)
returns bigint
language sql
security definer
set search_path = ''
as $$
  insert into public.order_counters as c (organization_id, last_number)
  values (p_org, 1)
  on conflict (organization_id) do update set last_number = c.last_number + 1
  returning c.last_number
$$;

-- ---------------------------------------------------------------------
-- Pedidos do vendedor
-- ---------------------------------------------------------------------
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  number bigint not null,
  status public.order_status not null default 'pending',
  request_id uuid not null,

  customer_name text not null check (char_length(customer_name) between 2 and 120),
  customer_email text check (customer_email is null or customer_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  customer_phone text check (customer_phone is null or customer_phone ~ '^[0-9]{10,13}$'),
  -- CPF (11) ou CNPJ (14), só dígitos.
  customer_document text check (customer_document is null or customer_document ~ '^([0-9]{11}|[0-9]{14})$'),

  ship_postal_code text not null check (ship_postal_code ~ '^[0-9]{8}$'),
  ship_street text not null check (char_length(ship_street) between 2 and 200),
  ship_number text not null check (char_length(ship_number) between 1 and 20),
  ship_complement text check (ship_complement is null or char_length(ship_complement) <= 100),
  ship_district text not null check (char_length(ship_district) between 2 and 100),
  ship_city text not null check (char_length(ship_city) between 2 and 100),
  ship_state text not null check (ship_state ~ '^[A-Z]{2}$'),

  subtotal_cents bigint not null check (subtotal_cents >= 0),
  shipping_cents bigint not null default 0 check (shipping_cents between 0 and 100000000000),
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  total_cents bigint not null check (total_cents >= 0),
  notes text check (notes is null or char_length(notes) <= 1000),

  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  shipped_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,

  check (total_cents = subtotal_cents + shipping_cents - discount_cents),
  unique (organization_id, number),
  unique (organization_id, request_id),
  unique (organization_id, id)
);

create index orders_org_created_idx on public.orders (organization_id, created_at desc);

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  order_id uuid not null,
  inventory_item_id uuid not null references public.inventory_items (id),
  product_id uuid not null,
  variant_id uuid,
  sku text not null,
  name text not null,
  attributes jsonb,
  quantity integer not null check (quantity between 1 and 10000),
  unit_price_cents bigint not null check (unit_price_cents between 0 and 100000000000),
  fulfillment public.fulfillment_mode not null,
  foreign key (organization_id, order_id)
    references public.orders (organization_id, id) on delete cascade
);

create index order_items_order_idx on public.order_items (order_id);

-- ---------------------------------------------------------------------
-- Pedidos de fornecimento (dropshipping)
-- ---------------------------------------------------------------------
create table public.supplier_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  seller_organization_id uuid not null references public.organizations (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  number bigint not null,
  status public.supplier_order_status not null default 'pending',

  -- Snapshot mínimo para entrega (sem e-mail, preço de venda ou notas).
  recipient_name text not null,
  recipient_phone text,
  recipient_document text,
  ship_postal_code text not null,
  ship_street text not null,
  ship_number text not null,
  ship_complement text,
  ship_district text not null,
  ship_city text not null,
  ship_state text not null,

  total_wholesale_cents bigint not null check (total_wholesale_cents >= 0),
  carrier text check (carrier is null or char_length(carrier) between 2 and 60),
  tracking_code text check (tracking_code is null or char_length(tracking_code) between 4 and 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  shipped_at timestamptz,
  cancelled_at timestamptz,
  unique (organization_id, number),
  unique (order_id, organization_id)
);

create index supplier_orders_org_created_idx on public.supplier_orders (organization_id, created_at desc);

create trigger supplier_orders_set_updated_at
  before update on public.supplier_orders
  for each row execute function public.set_updated_at();

create table public.supplier_order_items (
  id uuid primary key default gen_random_uuid(),
  supplier_order_id uuid not null references public.supplier_orders (id) on delete cascade,
  order_item_id uuid not null unique references public.order_items (id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items (id),
  sku text not null,
  name text not null,
  attributes jsonb,
  quantity integer not null check (quantity between 1 and 10000),
  unit_wholesale_cents bigint not null check (unit_wholesale_cents >= 0)
);

create index supplier_order_items_order_idx on public.supplier_order_items (supplier_order_id);

-- ---------------------------------------------------------------------
-- Privilégios e RLS: só leitura; escrita exclusivamente por RPC.
-- ---------------------------------------------------------------------
revoke all on table public.orders from anon, authenticated;
revoke all on table public.order_items from anon, authenticated;
revoke all on table public.supplier_orders from anon, authenticated;
revoke all on table public.supplier_order_items from anon, authenticated;

grant select on table public.orders to authenticated;
grant select on table public.order_items to authenticated;
grant select on table public.supplier_orders to authenticated;
grant select on table public.supplier_order_items to authenticated;

alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.supplier_orders enable row level security;
alter table public.supplier_order_items enable row level security;

create policy "orders: membros do vendedor leem"
  on public.orders for select to authenticated
  using (private.is_org_member(organization_id));

create policy "order_items: membros do vendedor leem"
  on public.order_items for select to authenticated
  using (private.is_org_member(organization_id));

-- Fornecedor (quem entrega) e vendedor (quem acompanha) leem.
create policy "supplier_orders: fornecedor e vendedor leem"
  on public.supplier_orders for select to authenticated
  using (
    private.is_org_member(organization_id)
    or private.is_org_member(seller_organization_id)
  );

create policy "supplier_order_items: fornecedor e vendedor leem"
  on public.supplier_order_items for select to authenticated
  using (
    exists (
      select 1 from public.supplier_orders so
      where so.id = supplier_order_id
        and (private.is_org_member(so.organization_id)
          or private.is_org_member(so.seller_organization_id))
    )
  );

-- ---------------------------------------------------------------------
-- Núcleo de estoque dos pedidos (sem checagem de papel: só chamado pelas
-- RPCs abaixo, que já validaram quem pode agir).
-- ---------------------------------------------------------------------

/** Trava os itens de estoque em ordem de id (evita deadlock entre pedidos). */
create function private.lock_inventory_items(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.inventory_items i
  where i.id = any (p_ids)
  order by i.id
  for update;
end;
$$;

/**
 * Origem de cada item de fornecedor de um pedido: organização e saldo do
 * fornecedor, snapshot e atacado atual. `supplier_item` nulo = origem
 * indisponível (anúncio removido/oculto, variação desvinculada).
 */
create function private.order_supplier_sources(p_order uuid)
returns table (
  order_item_id uuid,
  supplier_org uuid,
  supplier_item uuid,
  sku text,
  name text,
  attributes jsonb,
  quantity integer,
  wholesale bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    oi.id,
    l.organization_id,
    case when private.visible_listing(l.id) then si.id end,
    coalesce(sv.sku, sp.sku),
    sp.name,
    sv.attributes,
    oi.quantity,
    l.wholesale_price_cents
  from public.order_items oi
  join public.products p on p.id = oi.product_id
  left join public.product_variants v on v.id = oi.variant_id
  left join public.catalog_listings l on l.id = p.source_listing_id
  left join public.products sp on sp.id = l.product_id
  left join public.product_variants sv on sv.id = v.source_variant_id
  left join public.inventory_items si
    on si.product_id = sp.id
   and si.variant_id is not distinct from sv.id
   -- Produto de origem com variações só é vendido pelas variações.
   and (sv.id is not null or not exists (
     select 1 from public.product_variants x where x.product_id = sp.id))
  where oi.order_id = p_order and oi.fulfillment = 'supplier'
$$;

create function private.reserve_stock(p_item uuid, p_qty integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.inventory_items
  set reserved = reserved + p_qty
  where id = p_item and on_hand - reserved >= p_qty;
  if not found then
    raise exception 'orders.insufficient_stock';
  end if;
end;
$$;

create function private.release_stock(p_item uuid, p_qty integer)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.inventory_items set reserved = greatest(reserved - p_qty, 0) where id = p_item
$$;

/** Baixa definitiva: consome a reserva e registra `sale` no livro-razão (idempotente). */
create function private.consume_reserved_stock(p_item uuid, p_qty integer, p_request_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.inventory_items%rowtype;
begin
  select * into v_item from public.inventory_items i where i.id = p_item;
  if exists (
    select 1 from public.inventory_movements m
    where m.organization_id = v_item.organization_id and m.request_id = p_request_id
  ) then
    return;
  end if;
  if v_item.reserved < p_qty or v_item.on_hand < p_qty then
    raise exception 'orders.reservation_mismatch';
  end if;

  update public.inventory_items
  set reserved = reserved - p_qty, on_hand = on_hand - p_qty
  where id = p_item;

  insert into public.inventory_movements (
    organization_id, item_id, quantity_delta, on_hand_after, reason, note, created_by, request_id
  ) values (
    v_item.organization_id, p_item, -p_qty, v_item.on_hand - p_qty, 'sale', p_note, auth.uid(), p_request_id
  );
end;
$$;

/** Organização do pedido travado, validando papel de quem chama. */
create function private.lock_order_for(p_order uuid, p_roles public.org_role[])
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_order public.orders%rowtype;
begin
  select o.organization_id into v_org from public.orders o where o.id = p_order;
  if v_org is null or not private.has_org_role(v_org, p_roles) then
    raise exception 'orders.not_found';
  end if;
  select * into v_order from public.orders o where o.id = p_order for update;
  return v_order;
end;
$$;

-- ---------------------------------------------------------------------
-- RPCs do vendedor
-- ---------------------------------------------------------------------

/**
 * Cria um pedido pendente. `p_order` (jsonb): customer_* , ship_* ,
 * shipping_cents, discount_cents, notes e items: [{inventory_item_id,
 * quantity, unit_price_cents?}] (preço padrão = variação ou produto).
 * Idempotente por p_request_id.
 */
create function public.create_order(p_org uuid, p_order jsonb, p_request_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing uuid;
  v_order uuid;
  v_items jsonb := p_order -> 'items';
  v_item jsonb;
  v_inv public.inventory_items%rowtype;
  v_product public.products%rowtype;
  v_variant public.product_variants%rowtype;
  v_qty integer;
  v_price bigint;
  v_subtotal bigint := 0;
  v_shipping bigint := coalesce((p_order ->> 'shipping_cents')::bigint, 0);
  v_discount bigint := coalesce((p_order ->> 'discount_cents')::bigint, 0);
  v_mode public.fulfillment_mode;
  v_seen uuid[] := '{}';
begin
  if not private.has_org_role(p_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  if private.org_kind(p_org) <> 'seller' then
    raise exception 'orders.sellers_only' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'orders.invalid';
  end if;

  select o.id into v_existing from public.orders o
  where o.organization_id = p_org and o.request_id = p_request_id;
  if found then
    return v_existing;
  end if;

  if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) not between 1 and 100 then
    raise exception 'orders.invalid_items';
  end if;

  insert into public.orders (
    organization_id, number, request_id,
    customer_name, customer_email, customer_phone, customer_document,
    ship_postal_code, ship_street, ship_number, ship_complement, ship_district, ship_city, ship_state,
    subtotal_cents, shipping_cents, discount_cents, total_cents, notes, created_by
  ) values (
    p_org, private.next_order_number(p_org), p_request_id,
    btrim(p_order ->> 'customer_name'),
    nullif(lower(btrim(p_order ->> 'customer_email')), ''),
    nullif(btrim(p_order ->> 'customer_phone'), ''),
    nullif(btrim(p_order ->> 'customer_document'), ''),
    btrim(p_order ->> 'ship_postal_code'), btrim(p_order ->> 'ship_street'),
    btrim(p_order ->> 'ship_number'), nullif(btrim(p_order ->> 'ship_complement'), ''),
    btrim(p_order ->> 'ship_district'), btrim(p_order ->> 'ship_city'),
    upper(btrim(p_order ->> 'ship_state')),
    -- Desconto e totais finais só depois de somar os itens (total nunca negativo).
    0, v_shipping, 0, v_shipping,
    nullif(btrim(p_order ->> 'notes'), ''), auth.uid()
  )
  returning id into v_order;

  for v_item in select * from jsonb_array_elements(v_items) loop
    select * into v_inv from public.inventory_items i
    where i.id = (v_item ->> 'inventory_item_id')::uuid and i.organization_id = p_org;
    if v_inv.id is null or v_inv.id = any (v_seen) then
      raise exception 'orders.invalid_items';
    end if;
    v_seen := v_seen || v_inv.id;

    select * into v_product from public.products p where p.id = v_inv.product_id;
    v_variant := null;
    if v_inv.variant_id is not null then
      select * into v_variant from public.product_variants v where v.id = v_inv.variant_id;
    elsif exists (select 1 from public.product_variants v where v.product_id = v_product.id) then
      -- Produto com variações só é vendido pelas variações.
      raise exception 'orders.invalid_items';
    end if;
    if v_product.status <> 'active' or (v_variant.id is not null and not v_variant.is_active) then
      raise exception 'orders.item_unavailable';
    end if;

    v_qty := (v_item ->> 'quantity')::integer;
    v_price := coalesce(
      (v_item ->> 'unit_price_cents')::bigint, v_variant.price_cents, v_product.price_cents
    );
    if v_qty is null or v_qty not between 1 and 10000 or v_price < 0 then
      raise exception 'orders.invalid_items';
    end if;

    v_mode := case when v_product.source_listing_id is not null then 'supplier' else 'own_stock' end;
    if v_mode = 'supplier' and v_variant.id is not null and v_variant.source_variant_id is null then
      raise exception 'orders.source_unavailable';
    end if;

    insert into public.order_items (
      organization_id, order_id, inventory_item_id, product_id, variant_id,
      sku, name, attributes, quantity, unit_price_cents, fulfillment
    ) values (
      p_org, v_order, v_inv.id, v_product.id, v_variant.id,
      coalesce(v_variant.sku, v_product.sku), v_product.name, v_variant.attributes,
      v_qty, v_price, v_mode
    );
    v_subtotal := v_subtotal + v_qty * v_price;
  end loop;

  if v_discount > v_subtotal + v_shipping then
    raise exception 'orders.invalid_discount';
  end if;

  update public.orders
  set subtotal_cents = v_subtotal, discount_cents = v_discount,
      total_cents = v_subtotal + v_shipping - v_discount
  where id = v_order;

  return v_order;
end;
$$;

/**
 * Confirma: reserva estoque próprio e, para itens importados, cria um
 * pedido de fornecimento por fornecedor reservando o estoque dele.
 * Tudo ou nada.
 */
create function public.confirm_order(p_order uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype := private.lock_order_for(p_order, '{owner,admin}');
  r record;
  v_supplier_org uuid;
  v_supplier_order uuid;
  v_lock uuid[];
begin
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

/** Envio do vendedor: baixa o estoque próprio. Exige fornecedores já enviados. */
create function public.ship_order(p_order uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype := private.lock_order_for(p_order, '{owner,admin}');
  r record;
  v_lock uuid[];
begin
  if v_order.status <> 'confirmed' then
    raise exception 'orders.invalid_status';
  end if;
  if exists (
    select 1 from public.supplier_orders so where so.order_id = p_order and so.status <> 'shipped'
  ) then
    raise exception 'orders.awaiting_supplier';
  end if;

  select array_agg(distinct oi.inventory_item_id order by oi.inventory_item_id) into v_lock
  from public.order_items oi where oi.order_id = p_order and oi.fulfillment = 'own_stock';
  perform private.lock_inventory_items(coalesce(v_lock, '{}'));

  for r in select oi.id, oi.inventory_item_id, oi.quantity from public.order_items oi
    where oi.order_id = p_order and oi.fulfillment = 'own_stock' order by oi.id
  loop
    perform private.consume_reserved_stock(
      r.inventory_item_id, r.quantity, r.id, 'Pedido #' || v_order.number
    );
  end loop;

  update public.orders set status = 'shipped', shipped_at = now() where id = p_order;
end;
$$;

create function public.deliver_order(p_order uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype := private.lock_order_for(p_order, '{owner,admin}');
begin
  if v_order.status <> 'shipped' then
    raise exception 'orders.invalid_status';
  end if;
  update public.orders set status = 'delivered', delivered_at = now() where id = p_order;
end;
$$;

/** Cancela antes do envio: libera reservas próprias e do fornecedor. */
create function public.cancel_order(p_order uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype := private.lock_order_for(p_order, '{owner,admin}');
  r record;
  v_lock uuid[];
begin
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

-- ---------------------------------------------------------------------
-- RPC do fornecedor
-- ---------------------------------------------------------------------

/** Fornecedor envia: baixa o estoque dele e registra transportadora/rastreio. */
create function public.ship_supplier_order(p_supplier_order uuid, p_carrier text, p_tracking_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_so public.supplier_orders%rowtype;
  r record;
  v_lock uuid[];
begin
  select so.organization_id into v_org from public.supplier_orders so where so.id = p_supplier_order;
  if v_org is null or not private.has_org_role(v_org, '{owner,admin}') then
    raise exception 'orders.not_found';
  end if;

  -- Mesma ordem de travas do vendedor (pedido → fornecimento → estoque).
  perform 1 from public.orders o
  where o.id = (select so.order_id from public.supplier_orders so where so.id = p_supplier_order)
  for update;
  select * into v_so from public.supplier_orders so where so.id = p_supplier_order for update;

  if v_so.status <> 'pending' then
    raise exception 'orders.invalid_status';
  end if;

  select array_agg(distinct soi.inventory_item_id order by soi.inventory_item_id) into v_lock
  from public.supplier_order_items soi where soi.supplier_order_id = p_supplier_order;
  perform private.lock_inventory_items(coalesce(v_lock, '{}'));

  for r in select soi.id, soi.inventory_item_id, soi.quantity from public.supplier_order_items soi
    where soi.supplier_order_id = p_supplier_order order by soi.id
  loop
    perform private.consume_reserved_stock(
      r.inventory_item_id, r.quantity, r.id, 'Fornecimento #' || v_so.number
    );
  end loop;

  update public.supplier_orders
  set status = 'shipped', shipped_at = now(),
      carrier = nullif(btrim(p_carrier), ''), tracking_code = nullif(btrim(p_tracking_code), '')
  where id = p_supplier_order;
end;
$$;

grant execute on function public.create_order(uuid, jsonb, uuid) to authenticated;
grant execute on function public.confirm_order(uuid) to authenticated;
grant execute on function public.ship_order(uuid) to authenticated;
grant execute on function public.deliver_order(uuid) to authenticated;
grant execute on function public.cancel_order(uuid) to authenticated;
grant execute on function public.ship_supplier_order(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Preço de venda padrão na visão de saldos (usado ao montar pedidos).
-- Colunas novas só no final: `create or replace view` preserva as demais.
-- ---------------------------------------------------------------------
create or replace view public.inventory_levels
with (security_invoker = true)
as
select
  i.id,
  i.organization_id,
  i.product_id,
  i.variant_id,
  coalesce(v.sku, p.sku) as sku,
  p.name as product_name,
  v.attributes,
  p.status as product_status,
  coalesce(v.is_active, true) as is_active,
  i.on_hand,
  i.reserved,
  i.on_hand - i.reserved as available,
  i.min_quantity,
  (i.min_quantity is not null and i.on_hand - i.reserved <= i.min_quantity) as is_low,
  i.updated_at,
  coalesce(v.price_cents, p.price_cents) as price_cents,
  (p.source_listing_id is not null) as is_dropship
from public.inventory_items i
join public.products p on p.id = i.product_id
left join public.product_variants v on v.id = i.variant_id
where i.variant_id is not null
  or not exists (select 1 from public.product_variants pv where pv.product_id = i.product_id);
