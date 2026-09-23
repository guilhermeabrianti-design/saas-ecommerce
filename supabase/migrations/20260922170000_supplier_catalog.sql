-- =====================================================================
-- Fase 7 · Catálogo de fornecedores
--
-- Primeiro dado que cruza tenants. Regras:
--  * Só organizações `supplier` publicam; só membros de organizações
--    `seller` consultam o catálogo (fornecedores não veem uns aos outros).
--  * Vendedores nunca leem linhas de `products`/`product_variants` do
--    fornecedor: o catálogo é exposto por RPCs com colunas seguras
--    (sem custo, criador, datas internas ou saldo bruto).
--  * Importar cria um produto rascunho do vendedor com vínculo à origem
--    (`source_listing_id`, `source_variant_id`), base do roteamento de
--    pedidos nas próximas fases.
-- =====================================================================

create function private.org_kind(p_org uuid)
returns public.org_kind
language sql
stable
security definer
set search_path = ''
as $$
  select o.kind from public.organizations o where o.id = p_org
$$;

/** Membro de ao menos uma organização vendedora. */
create function private.is_seller_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
    where m.user_id = (select auth.uid()) and o.kind = 'seller'
  )
$$;

grant execute on function private.org_kind(uuid) to authenticated;
grant execute on function private.is_seller_member() to authenticated;

-- ---------------------------------------------------------------------
-- Anúncios do fornecedor no catálogo
-- ---------------------------------------------------------------------
create table public.catalog_listings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  product_id uuid not null,
  wholesale_price_cents bigint not null check (wholesale_price_cents between 0 and 100000000000),
  suggested_price_cents bigint check (
    suggested_price_cents is null or suggested_price_cents between 0 and 100000000000
  ),
  is_published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, product_id)
    references public.products (organization_id, id) on delete cascade,
  -- (organization_id, product_id), não só product_id: assim a FK recusa produto de
  -- outra organização antes do índice único revelar se ele já tem anúncio.
  unique (organization_id, product_id)
);

create index catalog_listings_published_idx
  on public.catalog_listings (updated_at desc) where is_published;

create trigger catalog_listings_set_updated_at
  before update on public.catalog_listings
  for each row execute function public.set_updated_at();

revoke all on table public.catalog_listings from anon, authenticated;
grant select on table public.catalog_listings to authenticated;
grant insert (organization_id, product_id, wholesale_price_cents, suggested_price_cents, is_published)
  on table public.catalog_listings to authenticated;
grant update (wholesale_price_cents, suggested_price_cents, is_published)
  on table public.catalog_listings to authenticated;

alter table public.catalog_listings enable row level security;

-- O próprio fornecedor gerencia seus anúncios; vendedores usam as RPCs.
create policy "catalog_listings: membros do fornecedor leem"
  on public.catalog_listings for select
  to authenticated
  using (private.is_org_member(organization_id));

create policy "catalog_listings: owner/admin de fornecedor criam"
  on public.catalog_listings for insert
  to authenticated
  with check (
    private.has_org_role(organization_id, '{owner,admin}')
    and private.org_kind(organization_id) = 'supplier'
  );

create policy "catalog_listings: owner/admin de fornecedor editam"
  on public.catalog_listings for update
  to authenticated
  using (private.has_org_role(organization_id, '{owner,admin}'))
  with check (
    private.has_org_role(organization_id, '{owner,admin}')
    and private.org_kind(organization_id) = 'supplier'
  );

-- ---------------------------------------------------------------------
-- Vínculo do produto do vendedor com a origem
-- ---------------------------------------------------------------------
alter table public.products
  add column source_listing_id uuid references public.catalog_listings (id) on delete set null;
alter table public.product_variants
  add column source_variant_id uuid references public.product_variants (id) on delete set null;

-- Um produto do vendedor por anúncio importado.
create unique index products_org_source_listing_key
  on public.products (organization_id, source_listing_id) where source_listing_id is not null;

-- Colunas de origem não entram nos grants de INSERT/UPDATE do cliente:
-- só a RPC de importação as preenche.

-- ---------------------------------------------------------------------
-- Consulta do catálogo (vendedores)
-- ---------------------------------------------------------------------

/** Anúncio visível: publicado, produto ativo. */
create function private.visible_listing(p_listing uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.catalog_listings l
    join public.products p on p.id = l.product_id
    where l.id = p_listing and l.is_published and p.status = 'active'
  )
$$;

create function public.search_catalog(p_query text, p_limit integer, p_offset integer)
returns table (
  listing_id uuid,
  supplier_name text,
  name text,
  brand text,
  wholesale_price_cents bigint,
  suggested_price_cents bigint,
  variant_count integer,
  available integer,
  cover_path text,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_term text := nullif(btrim(coalesce(p_query, '')), '');
begin
  if not private.is_seller_member() then
    raise exception 'catalog.sellers_only' using errcode = '42501';
  end if;

  return query
    select
      l.id,
      o.name,
      p.name,
      p.brand,
      l.wholesale_price_cents,
      l.suggested_price_cents,
      (select count(*)::integer from public.product_variants v
        where v.product_id = p.id and v.is_active),
      (select coalesce(sum(il.available), 0)::integer from public.inventory_levels il
        where il.product_id = p.id and il.is_active),
      (select i.storage_path from public.product_images i
        where i.product_id = p.id order by i.position limit 1),
      count(*) over ()
    from public.catalog_listings l
    join public.products p on p.id = l.product_id
    join public.organizations o on o.id = l.organization_id
    where l.is_published and p.status = 'active'
      and (
        v_term is null
        or p.name ilike '%' || v_term || '%'
        or p.brand ilike '%' || v_term || '%'
        or o.name ilike '%' || v_term || '%'
      )
    order by l.updated_at desc, l.id
    limit least(greatest(coalesce(p_limit, 24), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

/**
 * Detalhe de um anúncio visível: dados seguros do produto, variações ativas
 * com disponibilidade e caminhos das imagens.
 */
create function public.get_catalog_listing(p_listing uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not private.is_seller_member() then
    raise exception 'catalog.sellers_only' using errcode = '42501';
  end if;
  if not private.visible_listing(p_listing) then
    raise exception 'catalog.listing_not_found';
  end if;

  select jsonb_build_object(
    'listing_id', l.id,
    'supplier_name', o.name,
    'sku', p.sku,
    'name', p.name,
    'description', p.description,
    'brand', p.brand,
    'gtin', p.gtin,
    'weight_grams', p.weight_grams,
    'length_mm', p.length_mm,
    'width_mm', p.width_mm,
    'height_mm', p.height_mm,
    'wholesale_price_cents', l.wholesale_price_cents,
    'suggested_price_cents', l.suggested_price_cents,
    'available', (
      select coalesce(sum(il.available), 0) from public.inventory_levels il
      where il.product_id = p.id and il.is_active
    ),
    'variants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sku', v.sku,
        'attributes', v.attributes,
        'gtin', v.gtin,
        'available', coalesce(ii.on_hand - ii.reserved, 0)
      ) order by v.created_at)
      from public.product_variants v
      left join public.inventory_items ii on ii.variant_id = v.id
      where v.product_id = p.id and v.is_active
    ), '[]'::jsonb),
    'image_paths', coalesce((
      select jsonb_agg(i.storage_path order by i.position)
      from public.product_images i where i.product_id = p.id
    ), '[]'::jsonb)
  ) into v_result
  from public.catalog_listings l
  join public.products p on p.id = l.product_id
  join public.organizations o on o.id = l.organization_id
  where l.id = p_listing;

  return v_result;
end;
$$;

/**
 * Importa um anúncio para o catálogo interno de uma organização vendedora:
 * produto rascunho (preço = sugerido ou atacado; custo = atacado) e
 * variações ativas, com SKU = prefixo + SKU do fornecedor.
 */
create function public.import_catalog_listing(p_org uuid, p_listing uuid, p_sku_prefix text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prefix text := coalesce(btrim(p_sku_prefix), '');
  v_listing public.catalog_listings%rowtype;
  v_src public.products%rowtype;
  v_product uuid;
begin
  if not private.has_org_role(p_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  if private.org_kind(p_org) <> 'seller' then
    raise exception 'catalog.sellers_only' using errcode = '42501';
  end if;
  if v_prefix !~ '^[A-Za-z0-9._-]{0,20}$' then
    raise exception 'catalog.invalid_prefix';
  end if;
  if not private.visible_listing(p_listing) then
    raise exception 'catalog.listing_not_found';
  end if;

  select * into v_listing from public.catalog_listings l where l.id = p_listing;
  select * into v_src from public.products p where p.id = v_listing.product_id;

  if exists (
    select 1 from public.products p
    where p.organization_id = p_org and p.source_listing_id = p_listing
  ) then
    raise exception 'catalog.already_imported';
  end if;

  if char_length(v_prefix || v_src.sku) > 60 or exists (
    select 1 from public.product_variants v
    where v.product_id = v_src.id and v.is_active and char_length(v_prefix || v.sku) > 60
  ) then
    raise exception 'catalog.invalid_prefix';
  end if;

  insert into public.products (
    organization_id, sku, name, description, brand, gtin, price_cents, cost_cents,
    weight_grams, length_mm, width_mm, height_mm, status, source_listing_id
  ) values (
    p_org, v_prefix || v_src.sku, v_src.name, v_src.description, v_src.brand, v_src.gtin,
    coalesce(v_listing.suggested_price_cents, v_listing.wholesale_price_cents),
    v_listing.wholesale_price_cents,
    v_src.weight_grams, v_src.length_mm, v_src.width_mm, v_src.height_mm, 'draft', p_listing
  )
  returning id into v_product;

  insert into public.product_variants (
    organization_id, product_id, sku, attributes, gtin, weight_grams, source_variant_id
  )
  select p_org, v_product, v_prefix || v.sku, v.attributes, v.gtin, v.weight_grams, v.id
  from public.product_variants v
  where v.product_id = v_src.id and v.is_active
  order by v.created_at;

  return v_product;
exception
  when unique_violation then
    -- SKU já usado no catálogo do vendedor (ou importação concorrente).
    if sqlerrm = 'products.sku_taken' then
      raise exception 'products.sku_taken' using errcode = '23505';
    end if;
    raise exception 'catalog.already_imported';
end;
$$;

grant execute on function public.search_catalog(text, integer, integer) to authenticated;
grant execute on function public.get_catalog_listing(uuid) to authenticated;
grant execute on function public.import_catalog_listing(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- Storage: vendedores leem imagens de anúncios visíveis (para exibir e
-- copiar para o próprio produto ao importar).
-- ---------------------------------------------------------------------
create function private.is_catalog_image(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_seller_member() and exists (
    select 1
    from public.catalog_listings l
    join public.products p on p.id = l.product_id
    where l.is_published and p.status = 'active'
      and p_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[^/]+$'
      and p.id::text = split_part(p_name, '/', 2)
      and p.organization_id::text = split_part(p_name, '/', 1)
  )
$$;

grant execute on function private.is_catalog_image(text) to authenticated;

create policy "product-images: vendedores leem imagens do catálogo"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'product-images' and private.is_catalog_image(name));
