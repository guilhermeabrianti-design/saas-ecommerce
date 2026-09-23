-- =====================================================================
-- Fase 5 · Variações e imagens de produto
--
-- Variação = unidade vendável com SKU próprio (ex.: Camiseta / Azul / M).
-- O SKU é único na organização considerando produtos E variações, pois
-- estoque, anúncios e pedidos referenciam SKUs.
--
-- Imagens ficam no Storage (bucket privado `product-images`) no caminho
-- `{organization_id}/{product_id}/{arquivo}`; `product_images` guarda a
-- ordem. Acesso segue os papéis da organização, como em `products`.
-- =====================================================================

-- Permite FKs compostas (organization_id, product_id): o banco garante
-- que filhos de um produto pertencem à mesma organização dele.
alter table public.products
  add constraint products_org_id_key unique (organization_id, id);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

/** 1 a 3 atributos texto→texto, nomes 1–30 e valores 1–50 caracteres, sem espaços nas pontas. */
create function private.valid_variant_attributes(p_attrs jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_attrs) = 'object'
    and (select count(*) from jsonb_object_keys(p_attrs)) between 1 and 3
    and not exists (
      select 1
      from jsonb_each(p_attrs) as a(key, value)
      where jsonb_typeof(a.value) <> 'string'
        or a.key <> btrim(a.key) or char_length(a.key) not between 1 and 30
        or (a.value #>> '{}') <> btrim(a.value #>> '{}')
        or char_length(a.value #>> '{}') not between 1 and 50
    )
$$;

grant execute on function private.valid_variant_attributes(jsonb) to authenticated;

/**
 * SKU único por organização entre products e product_variants. Um lock
 * transacional por organização serializa escritas concorrentes de SKU.
 */
create function private.enforce_org_sku_unique()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_variant_id uuid := case when tg_table_name = 'product_variants' then new.id end;
  v_product_id uuid := case when tg_table_name = 'products' then new.id end;
begin
  -- BEFORE triggers run ahead of the RLS WITH CHECK. For callers who may not
  -- write to this organization, do nothing and let RLS refuse the row —
  -- otherwise "SKU taken" would reveal another tenant's SKUs.
  if auth.uid() is not null and not private.has_org_role(new.organization_id, '{owner,admin}') then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sku:' || new.organization_id::text, 0));

  if exists (
    select 1 from public.products p
    where p.organization_id = new.organization_id
      and lower(p.sku) = lower(new.sku)
      and p.id is distinct from v_product_id
  ) or exists (
    select 1 from public.product_variants v
    where v.organization_id = new.organization_id
      and lower(v.sku) = lower(new.sku)
      and v.id is distinct from v_variant_id
  ) then
    raise exception 'products.sku_taken' using errcode = '23505';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Variações
-- ---------------------------------------------------------------------
create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  product_id uuid not null,
  sku text not null check (sku ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$'),
  attributes jsonb not null check (private.valid_variant_attributes(attributes)),
  -- null = usa o valor do produto.
  price_cents bigint check (price_cents is null or price_cents between 0 and 100000000000),
  gtin text check (gtin is null or gtin ~ '^([0-9]{8}|[0-9]{12,14})$'),
  weight_grams integer check (weight_grams is null or weight_grams between 1 and 1000000),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, product_id)
    references public.products (organization_id, id) on delete cascade,
  -- A mesma combinação de atributos não se repete no produto.
  unique (product_id, attributes)
);

create unique index product_variants_org_sku_key
  on public.product_variants (organization_id, lower(sku));
create index product_variants_product_idx on public.product_variants (product_id, created_at);

create trigger product_variants_set_updated_at
  before update on public.product_variants
  for each row execute function public.set_updated_at();

create trigger product_variants_sku_unique
  before insert or update of sku on public.product_variants
  for each row execute function private.enforce_org_sku_unique();

create trigger products_sku_unique
  before insert or update of sku on public.products
  for each row execute function private.enforce_org_sku_unique();

revoke all on table public.product_variants from anon, authenticated;
grant select on table public.product_variants to authenticated;
grant insert (
  organization_id, product_id, sku, attributes, price_cents, gtin, weight_grams, is_active
) on table public.product_variants to authenticated;
grant update (sku, attributes, price_cents, gtin, weight_grams, is_active)
  on table public.product_variants to authenticated;
grant delete on table public.product_variants to authenticated;

alter table public.product_variants enable row level security;

create policy "product_variants: membros leem"
  on public.product_variants for select
  to authenticated
  using (private.is_org_member(organization_id));

create policy "product_variants: owner/admin criam"
  on public.product_variants for insert
  to authenticated
  with check (private.has_org_role(organization_id, '{owner,admin}'));

create policy "product_variants: owner/admin editam"
  on public.product_variants for update
  to authenticated
  using (private.has_org_role(organization_id, '{owner,admin}'))
  with check (private.has_org_role(organization_id, '{owner,admin}'));

-- Como produtos: só enquanto o produto é rascunho; depois, desativar.
create policy "product_variants: owner/admin excluem de rascunhos"
  on public.product_variants for delete
  to authenticated
  using (
    private.has_org_role(organization_id, '{owner,admin}')
    and exists (
      select 1 from public.products p
      where p.id = product_id and p.status = 'draft'
    )
  );

-- ---------------------------------------------------------------------
-- Imagens: metadados e ordem
-- ---------------------------------------------------------------------
create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  product_id uuid not null,
  storage_path text not null unique,
  position integer not null check (position between 0 and 9),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, product_id)
    references public.products (organization_id, id) on delete cascade,
  -- O arquivo precisa estar na pasta do próprio produto.
  check (
    storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9_-]{1,64}\.(jpg|png|webp)$'
    and split_part(storage_path, '/', 1) = organization_id::text
    and split_part(storage_path, '/', 2) = product_id::text
  ),
  -- Adiável: reordenar troca posições dentro de uma transação.
  unique (product_id, position) deferrable initially deferred
);

/** Posição automática (fim da fila) e limite de 10 imagens por produto. */
create function private.product_images_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  -- Como no trigger de SKU: sem papel na organização, a RLS recusa a linha
  -- sem que este trigger revele algo sobre o produto de outro tenant.
  if auth.uid() is not null and not private.has_org_role(new.organization_id, '{owner,admin}') then
    new.position := 0;
    return new;
  end if;

  -- Serializa inserções concorrentes no mesmo produto.
  perform 1 from public.products p where p.id = new.product_id for update;

  select count(*) into v_count from public.product_images i where i.product_id = new.product_id;
  if v_count >= 10 then
    raise exception 'products.image_limit';
  end if;

  select coalesce(max(i.position) + 1, 0) into new.position
  from public.product_images i
  where i.product_id = new.product_id;
  return new;
end;
$$;

create trigger product_images_before_insert
  before insert on public.product_images
  for each row execute function private.product_images_before_insert();

revoke all on table public.product_images from anon, authenticated;
grant select on table public.product_images to authenticated;
grant insert (organization_id, product_id, storage_path) on table public.product_images to authenticated;
grant update (position) on table public.product_images to authenticated;
grant delete on table public.product_images to authenticated;

alter table public.product_images enable row level security;

create policy "product_images: membros leem"
  on public.product_images for select
  to authenticated
  using (private.is_org_member(organization_id));

create policy "product_images: owner/admin criam"
  on public.product_images for insert
  to authenticated
  with check (private.has_org_role(organization_id, '{owner,admin}'));

create policy "product_images: owner/admin reordenam"
  on public.product_images for update
  to authenticated
  using (private.has_org_role(organization_id, '{owner,admin}'))
  with check (private.has_org_role(organization_id, '{owner,admin}'));

create policy "product_images: owner/admin excluem"
  on public.product_images for delete
  to authenticated
  using (private.has_org_role(organization_id, '{owner,admin}'));

/**
 * Reordena todas as imagens de um produto. security invoker: roda com a
 * RLS de quem chama. `p_image_ids` precisa conter cada imagem exatamente uma vez.
 */
create function public.set_product_image_order(p_product uuid, p_image_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select p.organization_id into v_org from public.products p where p.id = p_product;
  if v_org is null or not private.has_org_role(v_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;

  if cardinality(p_image_ids) <> (
      select count(*) from public.product_images i where i.product_id = p_product
    )
    or cardinality(p_image_ids) <> (select count(distinct x) from unnest(p_image_ids) as x)
    or exists (
      select 1 from unnest(p_image_ids) as t(id)
      where not exists (
        select 1 from public.product_images i where i.id = t.id and i.product_id = p_product
      )
    )
  then
    raise exception 'products.invalid_image_order';
  end if;

  update public.product_images i
  set position = t.ord - 1
  from unnest(p_image_ids) with ordinality as t(id, ord)
  where i.id = t.id and i.product_id = p_product;
end;
$$;

grant execute on function public.set_product_image_order(uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- Storage: bucket privado e policies por organização
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

/** Organização dona do caminho `{org}/{product}/{arquivo}`; null se malformado. */
create function private.product_image_path_org(p_name text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.organization_id
  from public.products p
  where p_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[^/]+$'
    and p.id::text = split_part(p_name, '/', 2)
    and p.organization_id::text = split_part(p_name, '/', 1)
$$;

grant execute on function private.product_image_path_org(text) to authenticated;

create policy "product-images: membros leem"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'product-images'
    and private.is_org_member(private.product_image_path_org(name))
  );

create policy "product-images: owner/admin enviam"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'product-images'
    and private.has_org_role(private.product_image_path_org(name), '{owner,admin}')
  );

create policy "product-images: owner/admin excluem"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'product-images'
    and private.has_org_role(private.product_image_path_org(name), '{owner,admin}')
  );
