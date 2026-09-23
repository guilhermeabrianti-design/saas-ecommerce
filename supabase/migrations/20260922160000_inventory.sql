-- =====================================================================
-- Fase 6 · Estoque
--
-- Saldo por unidade vendável: o produto (quando não tem variações) ou
-- cada variação. Todo saldo é resultado de movimentações registradas num
-- livro-razão imutável; a única forma de alterá-lo é pelas RPCs
-- `adjust_stock` / `set_stock`, que travam a linha, impedem saldo negativo
-- e são idempotentes por `p_request_id`.
--
-- `reserved` será usado pelos pedidos (fase futura); disponível =
-- on_hand − reserved.
-- =====================================================================

create type public.inventory_reason as enum ('purchase', 'return', 'adjustment', 'loss', 'count');

alter table public.product_variants
  add constraint product_variants_org_id_key unique (organization_id, id);

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  product_id uuid not null,
  variant_id uuid,
  on_hand integer not null default 0 check (on_hand between 0 and 1000000000),
  reserved integer not null default 0 check (reserved >= 0 and reserved <= on_hand),
  min_quantity integer check (min_quantity is null or min_quantity between 0 and 1000000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, product_id)
    references public.products (organization_id, id) on delete cascade,
  foreign key (organization_id, variant_id)
    references public.product_variants (organization_id, id) on delete cascade
);

-- Um saldo por produto (nível produto) e um por variação.
create unique index inventory_items_product_level_key
  on public.inventory_items (product_id) where variant_id is null;
create unique index inventory_items_variant_key
  on public.inventory_items (variant_id) where variant_id is not null;
create index inventory_items_org_idx on public.inventory_items (organization_id);

create trigger inventory_items_set_updated_at
  before update on public.inventory_items
  for each row execute function public.set_updated_at();

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  item_id uuid not null,
  quantity_delta integer not null check (quantity_delta <> 0 and abs(quantity_delta) <= 1000000),
  on_hand_after integer not null check (on_hand_after >= 0),
  reason public.inventory_reason not null,
  note text check (note is null or char_length(note) <= 500),
  -- Sem FK: o registro de auditoria sobrevive à exclusão do usuário.
  created_by uuid,
  request_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (item_id) references public.inventory_items (id) on delete cascade,
  unique (organization_id, request_id)
);

create index inventory_movements_item_idx on public.inventory_movements (item_id, created_at desc);

-- ---------------------------------------------------------------------
-- Livro-razão imutável: nem owner, nem service role, nem cascata.
-- (Consequência: produto/variação com movimentações não pode ser excluído
-- — deve ser arquivado/desativado.)
-- ---------------------------------------------------------------------
create function private.inventory_movements_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'inventory.ledger_immutable';
end;
$$;

create trigger inventory_movements_no_update
  before update or delete on public.inventory_movements
  for each row execute function private.inventory_movements_immutable();

create trigger inventory_movements_no_truncate
  before truncate on public.inventory_movements
  for each statement execute function private.inventory_movements_immutable();

-- ---------------------------------------------------------------------
-- Criação automática dos saldos
-- ---------------------------------------------------------------------
create function private.create_inventory_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'products' then
    insert into public.inventory_items (organization_id, product_id)
    values (new.organization_id, new.id);
  else
    insert into public.inventory_items (organization_id, product_id, variant_id)
    values (new.organization_id, new.product_id, new.id);
  end if;
  return new;
end;
$$;

create trigger products_create_inventory_item
  after insert on public.products
  for each row execute function private.create_inventory_item();

create trigger product_variants_create_inventory_item
  after insert on public.product_variants
  for each row execute function private.create_inventory_item();

/**
 * Produto com saldo próprio não ganha variações: o saldo ficaria órfão.
 * Mesma cautela dos triggers da Fase 5: só responde a quem pode escrever
 * na organização (ou ao servidor); os demais são recusados pela RLS.
 */
create function private.variant_requires_empty_product_stock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not private.has_org_role(new.organization_id, '{owner,admin}') then
    return new;
  end if;

  if exists (
    select 1 from public.inventory_items i
    where i.product_id = new.product_id and i.variant_id is null
      and (i.on_hand > 0 or i.reserved > 0)
  ) then
    raise exception 'inventory.product_has_stock';
  end if;
  return new;
end;
$$;

create trigger product_variants_require_empty_product_stock
  before insert on public.product_variants
  for each row execute function private.variant_requires_empty_product_stock();

-- Produtos e variações anteriores a esta fase.
insert into public.inventory_items (organization_id, product_id)
select p.organization_id, p.id from public.products p;
insert into public.inventory_items (organization_id, product_id, variant_id)
select v.organization_id, v.product_id, v.id from public.product_variants v;

-- ---------------------------------------------------------------------
-- Privilégios e RLS
-- ---------------------------------------------------------------------
revoke all on table public.inventory_items from anon, authenticated;
revoke all on table public.inventory_movements from anon, authenticated;

grant select on table public.inventory_items to authenticated;
grant update (min_quantity) on table public.inventory_items to authenticated;
grant select on table public.inventory_movements to authenticated;

alter table public.inventory_items enable row level security;
alter table public.inventory_movements enable row level security;

create policy "inventory_items: membros leem"
  on public.inventory_items for select
  to authenticated
  using (private.is_org_member(organization_id));

create policy "inventory_items: owner/admin definem o mínimo"
  on public.inventory_items for update
  to authenticated
  using (private.has_org_role(organization_id, '{owner,admin}'))
  with check (private.has_org_role(organization_id, '{owner,admin}'));

create policy "inventory_movements: membros leem"
  on public.inventory_movements for select
  to authenticated
  using (private.is_org_member(organization_id));

-- ---------------------------------------------------------------------
-- Visão de saldos para a UI: só unidades vendáveis (esconde o saldo de
-- nível produto quando o produto tem variações). security_invoker: a RLS
-- das tabelas de origem vale para quem consulta.
-- ---------------------------------------------------------------------
create view public.inventory_levels
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
  i.updated_at
from public.inventory_items i
join public.products p on p.id = i.product_id
left join public.product_variants v on v.id = i.variant_id
where i.variant_id is not null
  or not exists (select 1 from public.product_variants pv where pv.product_id = i.product_id);

revoke all on table public.inventory_levels from anon, authenticated;
grant select on table public.inventory_levels to authenticated;

-- ---------------------------------------------------------------------
-- Movimentação (núcleo) e RPCs
-- ---------------------------------------------------------------------

/**
 * Aplica uma movimentação com a linha do saldo travada. Idempotente:
 * repetir o mesmo p_request_id para o mesmo item devolve o saldo atual
 * sem movimentar de novo. Chamado apenas pelas RPCs abaixo.
 */
create function private.apply_stock_movement(
  p_item uuid,
  p_delta integer,
  p_reason public.inventory_reason,
  p_note text,
  p_request_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_item public.inventory_items%rowtype;
  v_existing uuid;
  v_new integer;
begin
  -- Mesmo erro para inexistente e de outra organização; papel checado
  -- antes de travar a linha.
  select i.organization_id into v_org from public.inventory_items i where i.id = p_item;
  if v_org is null or not private.has_org_role(v_org, '{owner,admin}') then
    raise exception 'inventory.item_not_found';
  end if;

  select * into v_item from public.inventory_items i where i.id = p_item for update;

  if p_request_id is null then
    raise exception 'inventory.request_id_required';
  end if;

  select m.item_id into v_existing
  from public.inventory_movements m
  where m.organization_id = v_item.organization_id and m.request_id = p_request_id;
  if found then
    if v_existing <> p_item then
      raise exception 'inventory.request_reused';
    end if;
    return v_item.on_hand;
  end if;

  if v_item.variant_id is null and exists (
    select 1 from public.product_variants v where v.product_id = v_item.product_id
  ) then
    raise exception 'inventory.use_variants';
  end if;

  if p_delta = 0 then
    return v_item.on_hand;
  end if;
  if abs(p_delta) > 1000000 then
    raise exception 'inventory.invalid_quantity';
  end if;

  v_new := v_item.on_hand + p_delta;
  if v_new < v_item.reserved or v_new < 0 then
    raise exception 'inventory.insufficient_stock';
  end if;
  if v_new > 1000000000 then
    raise exception 'inventory.invalid_quantity';
  end if;

  update public.inventory_items set on_hand = v_new where id = p_item;

  insert into public.inventory_movements (
    organization_id, item_id, quantity_delta, on_hand_after, reason, note, created_by, request_id
  ) values (
    v_item.organization_id, p_item, p_delta, v_new, p_reason,
    nullif(btrim(p_note), ''), auth.uid(), p_request_id
  );

  return v_new;
end;
$$;

/**
 * Entrada/saída relativa. Entradas (compra, devolução) são positivas;
 * perdas são negativas; ajuste aceita os dois sentidos.
 */
create function public.adjust_stock(
  p_item uuid,
  p_delta integer,
  p_reason public.inventory_reason,
  p_note text,
  p_request_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_reason = 'count'
    or (p_reason in ('purchase', 'return') and p_delta <= 0)
    or (p_reason = 'loss' and p_delta >= 0)
    or p_delta = 0
  then
    raise exception 'inventory.invalid_quantity';
  end if;
  return private.apply_stock_movement(p_item, p_delta, p_reason, p_note, p_request_id);
end;
$$;

/** Contagem de inventário: define o saldo físico; registra a diferença. */
create function public.set_stock(
  p_item uuid,
  p_quantity integer,
  p_note text,
  p_request_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_on_hand integer;
begin
  if p_quantity is null or p_quantity < 0 or p_quantity > 1000000000 then
    raise exception 'inventory.invalid_quantity';
  end if;
  -- Papel antes do lock: quem não pode movimentar não chega a travar a linha
  -- de outra organização.
  select i.organization_id into v_org from public.inventory_items i where i.id = p_item;
  if v_org is null or not private.has_org_role(v_org, '{owner,admin}') then
    raise exception 'inventory.item_not_found';
  end if;
  -- O delta é calculado sob o mesmo lock que a movimentação usará.
  select i.on_hand into v_on_hand from public.inventory_items i where i.id = p_item for update;
  return private.apply_stock_movement(
    p_item, p_quantity - coalesce(v_on_hand, 0), 'count', p_note, p_request_id
  );
end;
$$;

grant execute on function public.adjust_stock(uuid, integer, public.inventory_reason, text, uuid)
  to authenticated;
grant execute on function public.set_stock(uuid, integer, text, uuid) to authenticated;
