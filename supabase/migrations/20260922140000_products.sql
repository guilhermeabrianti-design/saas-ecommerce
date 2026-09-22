-- =====================================================================
-- Fase 4 · Produtos TheSigns (catálogo interno por organização)
--
-- O produto interno é a entidade principal: anúncios em marketplaces
-- (fases futuras) sempre derivam dele. Valores monetários em centavos
-- (BRL) como inteiros; nunca ponto flutuante.
--
-- Acesso: membros leem; owner/admin escrevem (papéis da Fase 3).
-- Só rascunhos podem ser excluídos; os demais são arquivados.
-- =====================================================================

create type public.product_status as enum ('draft', 'active', 'archived');

create table public.products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  sku text not null check (sku ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$'),
  name text not null check (name = btrim(name) and char_length(name) between 2 and 200),
  description text not null default '' check (char_length(description) <= 5000),
  brand text check (brand is null or (brand = btrim(brand) and char_length(brand) between 1 and 80)),
  -- EAN-8, UPC-A (12), EAN-13 ou GTIN-14.
  gtin text check (gtin is null or gtin ~ '^([0-9]{8}|[0-9]{12,14})$'),
  price_cents bigint not null check (price_cents between 0 and 100000000000),
  cost_cents bigint check (cost_cents is null or cost_cents between 0 and 100000000000),
  weight_grams integer check (weight_grams is null or weight_grams between 1 and 1000000),
  length_mm integer check (length_mm is null or length_mm between 1 and 10000),
  width_mm integer check (width_mm is null or width_mm between 1 and 10000),
  height_mm integer check (height_mm is null or height_mm between 1 and 10000),
  status public.product_status not null default 'draft',
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.products is 'Produto interno TheSigns. Fonte da verdade para anúncios.';

-- SKU único por organização, sem diferenciar maiúsculas.
create unique index products_org_sku_key on public.products (organization_id, lower(sku));
create index products_org_updated_idx on public.products (organization_id, updated_at desc);

create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Privilégios por coluna: organization_id só na criação; created_by,
-- created_at e updated_at nunca pelo cliente.
-- ---------------------------------------------------------------------
revoke all on table public.products from anon, authenticated;

grant select on table public.products to authenticated;
grant insert (
  organization_id, sku, name, description, brand, gtin, price_cents, cost_cents,
  weight_grams, length_mm, width_mm, height_mm, status
) on table public.products to authenticated;
grant update (
  sku, name, description, brand, gtin, price_cents, cost_cents,
  weight_grams, length_mm, width_mm, height_mm, status
) on table public.products to authenticated;
grant delete on table public.products to authenticated;

alter table public.products enable row level security;

create policy "products: membros leem"
  on public.products for select
  to authenticated
  using (private.is_org_member(organization_id));

create policy "products: owner/admin criam"
  on public.products for insert
  to authenticated
  with check (private.has_org_role(organization_id, '{owner,admin}'));

create policy "products: owner/admin editam"
  on public.products for update
  to authenticated
  using (private.has_org_role(organization_id, '{owner,admin}'))
  with check (private.has_org_role(organization_id, '{owner,admin}'));

create policy "products: owner/admin excluem rascunhos"
  on public.products for delete
  to authenticated
  using (private.has_org_role(organization_id, '{owner,admin}') and status = 'draft');
