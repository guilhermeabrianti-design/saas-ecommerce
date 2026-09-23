-- =====================================================================
-- Fase 10 · Integrações de marketplace (núcleo)
--
--  * Conexões por organização vendedora (Shopify e WooCommerce liberados;
--    os demais provedores existem no enum, mas ainda não são conectáveis).
--  * Segredo de webhook em tabela SEM nenhum privilégio para a API:
--    só as RPCs (definer) e o service role tocam nele; nunca é devolvido.
--  * Vínculo SKU do marketplace → item de estoque próprio.
--  * Pedidos recebidos entram como `pending` por `ingest_marketplace_order`
--    (só service role), idempotente por (conexão, id externo). Pedido que
--    não pôde ser criado (SKU sem vínculo, dado inválido) fica no log com o
--    payload, e o vendedor reprocessa depois de corrigir.
--  * Estoque de saída: outbox com uma linha pendente por vínculo; o worker
--    (service role) reivindica e conclui com backoff.
--  * `create_order` passa a delegar a `private.create_order_core`, para que
--    pedidos manuais e de marketplace tenham exatamente as mesmas regras.
-- =====================================================================

create type public.marketplace_provider as enum (
  'shopify', 'woocommerce', 'mercadolivre', 'shopee', 'tiktok'
);
create type public.connection_status as enum ('active', 'paused', 'disconnected');
create type public.integration_event_status as enum ('ok', 'error', 'skipped');

-- ---------------------------------------------------------------------
-- Pedido: núcleo compartilhado (sem checagem de papel; quem chama valida)
-- ---------------------------------------------------------------------
create function private.create_order_core(
  p_org uuid,
  p_order jsonb,
  p_request_id uuid,
  p_actor uuid
)
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
    nullif(btrim(p_order ->> 'notes'), ''), p_actor
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

create or replace function public.create_order(p_org uuid, p_order jsonb, p_request_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_org_role(p_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  if private.org_kind(p_org) <> 'seller' then
    raise exception 'orders.sellers_only' using errcode = '42501';
  end if;
  return private.create_order_core(p_org, p_order, p_request_id, auth.uid());
end;
$$;

-- ---------------------------------------------------------------------
-- Conexões e segredos
-- ---------------------------------------------------------------------
create table public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider public.marketplace_provider not null,
  name text not null check (char_length(name) between 2 and 80),
  -- Domínio da loja (Shopify) ou URL (WooCommerce): identifica a conta no provedor.
  external_account_id text not null check (char_length(external_account_id) between 1 and 200),
  status public.connection_status not null default 'active',
  last_event_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, external_account_id),
  unique (organization_id, id)
);

create trigger integration_connections_set_updated_at
  before update on public.integration_connections
  for each row execute function public.set_updated_at();

-- Segredo de assinatura do webhook: nenhum privilégio para anon/authenticated.
create table public.integration_secrets (
  connection_id uuid primary key references public.integration_connections (id) on delete cascade,
  secret text not null check (char_length(secret) between 16 and 200)
);

-- ---------------------------------------------------------------------
-- Vínculos SKU do marketplace ↔ estoque próprio
-- ---------------------------------------------------------------------
create table public.listing_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  connection_id uuid not null,
  inventory_item_id uuid not null references public.inventory_items (id) on delete cascade,
  -- SKU/identificador do item no marketplace.
  external_id text not null check (char_length(external_id) between 1 and 120),
  sync_stock boolean not null default true,
  last_pushed_available integer,
  last_pushed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (organization_id, connection_id)
    references public.integration_connections (organization_id, id) on delete cascade,
  unique (connection_id, external_id),
  unique (connection_id, inventory_item_id)
);

-- ---------------------------------------------------------------------
-- Pedidos recebidos e log de eventos
-- ---------------------------------------------------------------------
create table public.external_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  connection_id uuid not null references public.integration_connections (id) on delete cascade,
  external_id text not null,
  order_id uuid not null references public.orders (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (connection_id, external_id)
);

create index external_orders_order_idx on public.external_orders (order_id);

create table public.integration_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  connection_id uuid not null references public.integration_connections (id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  kind text not null check (char_length(kind) between 1 and 60),
  external_id text,
  status public.integration_event_status not null,
  message text check (message is null or char_length(message) <= 500),
  -- Só em erros de pedido (para reprocessar); contém dados do cliente.
  payload jsonb,
  retryable boolean generated always as (payload is not null) stored,
  created_at timestamptz not null default now()
);

create index integration_events_conn_idx
  on public.integration_events (connection_id, created_at desc);

-- ---------------------------------------------------------------------
-- Outbox de estoque (uma linha pendente por vínculo)
-- ---------------------------------------------------------------------
create table public.stock_sync_outbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  link_id uuid not null references public.listing_links (id) on delete cascade,
  available integer not null check (available >= 0),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  done_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  created_at timestamptz not null default now()
);

create unique index stock_sync_outbox_pending_uidx
  on public.stock_sync_outbox (link_id)
  where claimed_at is null and done_at is null;

create index stock_sync_outbox_due_idx
  on public.stock_sync_outbox (next_attempt_at)
  where done_at is null;

-- ---------------------------------------------------------------------
-- Privilégios e RLS: leitura só para owner/admin; escrita só por RPC.
-- Segredos e outbox sem nenhum privilégio para a API.
-- ---------------------------------------------------------------------
revoke all on table public.integration_connections from anon, authenticated;
revoke all on table public.integration_secrets from anon, authenticated;
revoke all on table public.listing_links from anon, authenticated;
revoke all on table public.external_orders from anon, authenticated;
revoke all on table public.integration_events from anon, authenticated;
revoke all on table public.stock_sync_outbox from anon, authenticated;

grant select on table public.integration_connections to authenticated;
grant select on table public.listing_links to authenticated;
grant select on table public.external_orders to authenticated;
-- O payload (dados do cliente) nunca sai pela API: só a coluna `retryable`.
grant select (id, organization_id, connection_id, direction, kind, external_id, status, message, retryable, created_at)
  on table public.integration_events to authenticated;

alter table public.integration_connections enable row level security;
alter table public.integration_secrets enable row level security;
alter table public.listing_links enable row level security;
alter table public.external_orders enable row level security;
alter table public.integration_events enable row level security;
alter table public.stock_sync_outbox enable row level security;

create policy "integration_connections: owner/admin leem"
  on public.integration_connections for select to authenticated
  using (private.has_org_role(organization_id, '{owner,admin}'));

create policy "listing_links: owner/admin leem"
  on public.listing_links for select to authenticated
  using (private.has_org_role(organization_id, '{owner,admin}'));

create policy "external_orders: owner/admin leem"
  on public.external_orders for select to authenticated
  using (private.has_org_role(organization_id, '{owner,admin}'));

create policy "integration_events: owner/admin leem"
  on public.integration_events for select to authenticated
  using (private.has_org_role(organization_id, '{owner,admin}'));

-- ---------------------------------------------------------------------
-- RPCs do vendedor
-- ---------------------------------------------------------------------

/** Cria a conexão e guarda o segredo do webhook (nunca devolvido). */
create function public.create_connection(
  p_org uuid,
  p_provider public.marketplace_provider,
  p_name text,
  p_external_account_id text,
  p_secret text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not private.has_org_role(p_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  if private.org_kind(p_org) <> 'seller' then
    raise exception 'integrations.sellers_only' using errcode = '42501';
  end if;
  if p_provider not in ('shopify', 'woocommerce') then
    raise exception 'integrations.provider_unavailable';
  end if;

  insert into public.integration_connections (
    organization_id, provider, name, external_account_id, created_by
  ) values (
    p_org, p_provider, btrim(p_name), lower(btrim(p_external_account_id)), auth.uid()
  )
  returning id into v_id;

  insert into public.integration_secrets (connection_id, secret) values (v_id, btrim(p_secret));
  return v_id;
end;
$$;

create function public.rotate_connection_secret(p_connection uuid, p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select c.organization_id into v_org from public.integration_connections c
  where c.id = p_connection and c.status <> 'disconnected';
  if v_org is null or not private.has_org_role(v_org, '{owner,admin}') then
    raise exception 'integrations.not_found';
  end if;
  update public.integration_secrets set secret = btrim(p_secret) where connection_id = p_connection;
end;
$$;

/** Pausa/retoma. Desconectar é definitivo: apaga o segredo e para a sincronização. */
create function public.set_connection_status(p_connection uuid, p_status public.connection_status)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.integration_connections%rowtype;
begin
  select * into v_conn from public.integration_connections c where c.id = p_connection for update;
  if v_conn.id is null or not private.has_org_role(v_conn.organization_id, '{owner,admin}') then
    raise exception 'integrations.not_found';
  end if;
  if v_conn.status = 'disconnected' then
    raise exception 'integrations.disconnected';
  end if;

  if p_status = 'disconnected' then
    delete from public.integration_secrets where connection_id = p_connection;
    -- Nada de estoque pendente para uma conexão encerrada.
    delete from public.stock_sync_outbox o using public.listing_links l
    where o.link_id = l.id and l.connection_id = p_connection and o.done_at is null;
  end if;
  update public.integration_connections set status = p_status where id = p_connection;
end;
$$;

/** Vincula um SKU do marketplace a um item de estoque próprio (não dropshipping). */
create function public.link_listing(
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
    join public.products p on p.id = i.product_id
    where i.id = p_inventory_item and i.organization_id = v_conn.organization_id
      and p.source_listing_id is null
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
    select v_conn.organization_id, v_id, greatest(i.on_hand - i.reserved, 0)
    from public.inventory_items i where i.id = p_inventory_item;
  end if;
  return v_id;
end;
$$;

create function public.unlink_listing(p_link uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select l.organization_id into v_org from public.listing_links l where l.id = p_link;
  if v_org is null or not private.has_org_role(v_org, '{owner,admin}') then
    raise exception 'integrations.not_found';
  end if;
  delete from public.listing_links where id = p_link;
end;
$$;

-- ---------------------------------------------------------------------
-- Recebimento de pedidos
-- ---------------------------------------------------------------------

/**
 * Cria o pedido pendente de um pedido do marketplace. Retorna:
 * 'created' | 'duplicate' | 'unmapped' | 'invalid' | 'inactive'.
 * Nunca lança por dado do pedido: a falha vira evento de erro (com o payload
 * para reprocessar) e o chamador decide a resposta HTTP.
 */
create function private.ingest_order(p_connection uuid, p_external_id text, p_order jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.integration_connections%rowtype;
  v_missing text[];
  v_conflict boolean;
  v_items jsonb;
  v_order_id uuid;
  v_number bigint;
begin
  select * into v_conn from public.integration_connections c where c.id = p_connection;
  if v_conn.id is null or v_conn.status <> 'active' then
    return 'inactive';
  end if;
  -- Serializa o mesmo pedido externo (retentativas do webhook em paralelo).
  perform pg_advisory_xact_lock(hashtextextended(p_connection::text || ':' || p_external_id, 0));
  if exists (
    select 1 from public.external_orders e
    where e.connection_id = p_connection and e.external_id = p_external_id
  ) then
    return 'duplicate';
  end if;

  update public.integration_connections set last_event_at = now() where id = p_connection;

  begin
    if jsonb_typeof(p_order -> 'items') <> 'array' then
      raise exception 'orders.invalid_items';
    end if;

    -- SKUs sem vínculo.
    select array_agg(distinct it ->> 'external_item_id') into v_missing
    from jsonb_array_elements(p_order -> 'items') it
    where not exists (
      select 1 from public.listing_links l
      where l.connection_id = p_connection and l.external_id = it ->> 'external_item_id'
    );
    if v_missing is not null then
      insert into public.integration_events (
        organization_id, connection_id, direction, kind, external_id, status, message, payload
      ) values (
        v_conn.organization_id, p_connection, 'inbound', 'order.unmapped', p_external_id, 'error',
        left('SKUs sem vínculo: ' || array_to_string(v_missing, ', '), 500),
        jsonb_build_object('external_id', p_external_id, 'order', p_order)
      );
      return 'unmapped';
    end if;

    -- Mesmo SKU em mais de uma linha: soma; preços diferentes não se somam.
    select bool_or(n > 1) into v_conflict from (
      select count(distinct (it ->> 'unit_price_cents')) as n
      from jsonb_array_elements(p_order -> 'items') it
      group by it ->> 'external_item_id'
    ) t;
    if coalesce(v_conflict, false) then
      raise exception 'integrations.conflicting_prices';
    end if;

    select jsonb_agg(jsonb_build_object(
      'inventory_item_id', g.inventory_item_id,
      'quantity', g.quantity,
      'unit_price_cents', g.price
    )) into v_items
    from (
      select l.inventory_item_id, sum((it ->> 'quantity')::integer) as quantity,
             max((it ->> 'unit_price_cents')::bigint) as price
      from jsonb_array_elements(p_order -> 'items') it
      join public.listing_links l
        on l.connection_id = p_connection and l.external_id = it ->> 'external_item_id'
      group by l.inventory_item_id
    ) g;

    v_order_id := private.create_order_core(
      v_conn.organization_id,
      (p_order - 'items') || jsonb_build_object('items', v_items),
      -- Determinístico: a mesma (conexão, pedido externo) nunca cria dois pedidos.
      md5(p_connection::text || ':' || p_external_id)::uuid,
      null
    );
  exception when others then
    insert into public.integration_events (
      organization_id, connection_id, direction, kind, external_id, status, message, payload
    ) values (
      v_conn.organization_id, p_connection, 'inbound', 'order.invalid', p_external_id, 'error',
      left(sqlerrm, 500),
      jsonb_build_object('external_id', p_external_id, 'order', p_order)
    );
    return 'invalid';
  end;

  insert into public.external_orders (organization_id, connection_id, external_id, order_id)
  values (v_conn.organization_id, p_connection, p_external_id, v_order_id);

  select o.number into v_number from public.orders o where o.id = v_order_id;
  insert into public.integration_events (
    organization_id, connection_id, direction, kind, external_id, status, message
  ) values (
    v_conn.organization_id, p_connection, 'inbound', 'order.created', p_external_id, 'ok',
    'Pedido #' || v_number || ' criado como pendente'
  );
  return 'created';
end;
$$;

/** Entrada do webhook (Edge Function com service role). */
create function public.ingest_marketplace_order(p_connection uuid, p_external_id text, p_order jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_external_id is null or char_length(p_external_id) not between 1 and 120 then
    raise exception 'integrations.invalid';
  end if;
  return private.ingest_order(p_connection, p_external_id, p_order);
end;
$$;

/** Reprocessa um evento de erro (depois de vincular o SKU ou corrigir o produto). */
create function public.retry_integration_event(p_event uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.integration_events%rowtype;
  v_result text;
begin
  select * into v_event from public.integration_events e where e.id = p_event;
  if v_event.id is null or not private.has_org_role(v_event.organization_id, '{owner,admin}') then
    raise exception 'integrations.not_found';
  end if;
  select * into v_event from public.integration_events e where e.id = p_event for update;
  if v_event.status <> 'error' or v_event.payload is null then
    raise exception 'integrations.not_retryable';
  end if;

  v_result := private.ingest_order(
    v_event.connection_id, v_event.payload ->> 'external_id', v_event.payload -> 'order'
  );
  if v_result in ('created', 'duplicate') then
    update public.integration_events
    set status = 'skipped', message = 'Reprocessado com sucesso', payload = null
    where id = p_event;
  end if;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------
-- Estoque de saída
-- ---------------------------------------------------------------------
create function private.enqueue_stock_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.stock_sync_outbox (organization_id, link_id, available)
  select l.organization_id, l.id, greatest(new.on_hand - new.reserved, 0)
  from public.listing_links l
  join public.integration_connections c on c.id = l.connection_id
  where l.inventory_item_id = new.id and l.sync_stock and c.status = 'active'
  on conflict (link_id) where claimed_at is null and done_at is null
  do update set available = excluded.available, created_at = now(), next_attempt_at = now();
  return new;
end;
$$;

create trigger inventory_items_enqueue_stock_sync
  after update of on_hand, reserved on public.inventory_items
  for each row
  when (old.on_hand - old.reserved is distinct from new.on_hand - new.reserved)
  execute function private.enqueue_stock_sync();

/** Worker: reivindica pendências vencidas (ou com reivindicação vencida há 10 min). */
create function public.claim_stock_sync(p_limit integer default 20)
returns table (
  id uuid,
  connection_id uuid,
  provider public.marketplace_provider,
  external_account_id text,
  external_id text,
  available integer
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
  select cl.id, c.id, c.provider, c.external_account_id, l.external_id, cl.available
  from claimed cl
  join public.listing_links l on l.id = cl.link_id
  join public.integration_connections c on c.id = l.connection_id
$$;

/** Worker: conclui (p_error nulo) ou registra a falha; após 5 tentativas desiste e loga. */
create function public.complete_stock_sync(p_id uuid, p_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.stock_sync_outbox%rowtype;
  v_link public.listing_links%rowtype;
begin
  select * into v_row from public.stock_sync_outbox o where o.id = p_id for update;
  if v_row.id is null or v_row.done_at is not null then
    return;
  end if;
  select * into v_link from public.listing_links l where l.id = v_row.link_id;

  if p_error is null then
    update public.stock_sync_outbox set done_at = now(), last_error = null where id = p_id;
    update public.listing_links
    set last_pushed_available = v_row.available, last_pushed_at = now()
    where id = v_row.link_id;
  elsif exists (
    select 1 from public.stock_sync_outbox o
    where o.link_id = v_row.link_id and o.claimed_at is null and o.done_at is null
  ) then
    -- Já existe um valor mais novo pendente para este vínculo: este ficou obsoleto.
    update public.stock_sync_outbox
    set done_at = now(), last_error = left(p_error, 500) where id = p_id;
  elsif v_row.attempts >= 5 then
    update public.stock_sync_outbox set done_at = now(), last_error = left(p_error, 500) where id = p_id;
    insert into public.integration_events (
      organization_id, connection_id, direction, kind, external_id, status, message
    ) values (
      v_row.organization_id, v_link.connection_id, 'outbound', 'stock.failed', v_link.external_id,
      'error', left('Estoque não enviado após 5 tentativas: ' || p_error, 500)
    );
  else
    update public.stock_sync_outbox
    set claimed_at = null, last_error = left(p_error, 500),
        next_attempt_at = now() + (v_row.attempts * interval '2 minutes')
    where id = p_id;
  end if;
end;
$$;

-- Vendedor.
grant execute on function public.create_connection(uuid, public.marketplace_provider, text, text, text) to authenticated;
grant execute on function public.rotate_connection_secret(uuid, text) to authenticated;
grant execute on function public.set_connection_status(uuid, public.connection_status) to authenticated;
grant execute on function public.link_listing(uuid, uuid, text, boolean) to authenticated;
grant execute on function public.unlink_listing(uuid) to authenticated;
grant execute on function public.retry_integration_event(uuid) to authenticated;

-- Só service role (Edge Functions).
grant execute on function public.ingest_marketplace_order(uuid, text, jsonb) to service_role;
grant execute on function public.claim_stock_sync(integer) to service_role;
grant execute on function public.complete_stock_sync(uuid, text) to service_role;
grant select on table public.integration_secrets to service_role;
