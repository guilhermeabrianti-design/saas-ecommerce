-- =====================================================================
-- Fase 16 · Moderação: aprovação de fornecedores e de anúncios
--
--  * Fornecedor novo nasce `pending`; só fornecedor `approved` aparece no
--    catálogo. Reprovado vê o motivo e pode pedir nova análise.
--  * Anúncio novo nasce `pending`. A equipe aprova, reprova (fornecedor
--    corrige e reenvia) ou bloqueia (só a equipe desbloqueia).
--  * Visibilidade para vendedores = publicado + produto ativo + anúncio
--    aprovado + fornecedor aprovado e não suspenso. Vale para catálogo,
--    detalhe, importação, imagens, calculadora e roteamento de pedidos
--    (todos passam por `private.visible_listing` ou pelos mesmos filtros).
--  * Organizações e anúncios que já existiam ficam aprovados.
--  * A equipe pode corrigir nome, descrição e categoria de um anúncio.
--    Tudo auditado.
-- =====================================================================

create type public.approval_status as enum ('pending', 'approved', 'rejected');
create type public.listing_moderation as enum ('pending', 'approved', 'rejected', 'blocked');

-- ---------------------------------------------------------------------
-- Fornecedores
-- ---------------------------------------------------------------------
alter table public.organizations
  add column approval_status public.approval_status not null default 'approved',
  add column approval_reason text check (
    approval_reason is null or char_length(approval_reason) between 3 and 500
  ),
  add column approval_reviewed_at timestamptz;

create index organizations_supplier_approval_idx
  on public.organizations (approval_status, created_at) where kind = 'supplier';

-- Fornecedor criado daqui em diante aguarda análise (vendedor não passa por isso).
create function private.organization_initial_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.approval_status := case when new.kind = 'supplier' then 'pending' else 'approved' end;
  new.approval_reason := null;
  new.approval_reviewed_at := null;
  return new;
end;
$$;

create trigger organizations_initial_approval
  before insert on public.organizations
  for each row execute function private.organization_initial_approval();

-- ---------------------------------------------------------------------
-- Anúncios
-- ---------------------------------------------------------------------
alter table public.catalog_listings
  add column moderation_status public.listing_moderation not null default 'approved',
  add column moderation_reason text check (
    moderation_reason is null or char_length(moderation_reason) between 3 and 500
  ),
  add column moderated_at timestamptz;

alter table public.catalog_listings alter column moderation_status set default 'pending';

create index catalog_listings_moderation_idx
  on public.catalog_listings (moderation_status, updated_at);

-- Colunas de moderação não entram nos grants do cliente (só RPCs as alteram).

-- ---------------------------------------------------------------------
-- Visibilidade (create or replace mantém os grants)
-- ---------------------------------------------------------------------
create or replace function private.visible_listing(p_listing uuid)
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
    join public.organizations o on o.id = l.organization_id
    where l.id = p_listing and l.is_published and p.status = 'active'
      and l.moderation_status = 'approved'
      and o.suspended_at is null and o.approval_status = 'approved'
  )
$$;

create or replace function public.search_catalog(p_query text, p_limit integer, p_offset integer)
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
    where l.is_published and p.status = 'active' and l.moderation_status = 'approved'
      and o.suspended_at is null and o.approval_status = 'approved'
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

create or replace function private.is_catalog_image(p_name text)
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
    join public.organizations o on o.id = l.organization_id
    where l.is_published and p.status = 'active' and l.moderation_status = 'approved'
      and o.suspended_at is null and o.approval_status = 'approved'
      and p_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[^/]+$'
      and p.id::text = split_part(p_name, '/', 2)
      and p.organization_id::text = split_part(p_name, '/', 1)
  )
$$;

-- A equipe vê as imagens de produtos que têm anúncio no catálogo (para moderar).
create function private.is_moderation_image(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_platform_admin() and exists (
    select 1
    from public.catalog_listings l
    join public.products p on p.id = l.product_id
    where p_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[^/]+$'
      and p.id::text = split_part(p_name, '/', 2)
      and p.organization_id::text = split_part(p_name, '/', 1)
  )
$$;

grant execute on function private.is_moderation_image(text) to authenticated;

create policy "product-images: equipe lê imagens de anúncios"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'product-images' and private.is_moderation_image(name));

-- ---------------------------------------------------------------------
-- RPCs do fornecedor
-- ---------------------------------------------------------------------

/** Reenvia para análise um anúncio reprovado (bloqueado não pode). */
create function public.resubmit_catalog_listing(p_listing uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_listing public.catalog_listings%rowtype;
begin
  select * into v_listing from public.catalog_listings l where l.id = p_listing;
  if v_listing.id is null or not private.has_org_role(v_listing.organization_id, '{owner,admin}') then
    raise exception 'moderation.not_found';
  end if;
  select * into v_listing from public.catalog_listings l where l.id = p_listing for update;
  if v_listing.moderation_status = 'blocked' then
    raise exception 'moderation.blocked';
  end if;
  if v_listing.moderation_status <> 'rejected' then
    raise exception 'moderation.no_change';
  end if;
  update public.catalog_listings set moderation_status = 'pending' where id = p_listing;
end;
$$;

/** Fornecedor reprovado pede nova análise (só o proprietário). */
create function public.request_supplier_review(p_org uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.approval_status;
begin
  if not private.has_org_role(p_org, '{owner}') then
    raise exception 'moderation.not_found';
  end if;
  select o.approval_status into v_status from public.organizations o
  where o.id = p_org and o.kind = 'supplier' for update;
  if v_status is null then
    raise exception 'moderation.not_found';
  end if;
  if v_status <> 'rejected' then
    raise exception 'moderation.no_change';
  end if;
  update public.organizations set approval_status = 'pending' where id = p_org;
end;
$$;

-- ---------------------------------------------------------------------
-- RPCs da equipe
-- ---------------------------------------------------------------------
create function public.admin_supplier_reviews(
  p_status public.approval_status,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  name text,
  created_at timestamptz,
  owner_name text,
  owner_email text,
  products bigint,
  listings bigint,
  approval_status public.approval_status,
  approval_reason text,
  approval_reviewed_at timestamptz,
  suspended_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return query
  select o.id, o.name, o.created_at,
    (select pr.full_name from public.profiles pr where pr.id = o.created_by),
    (select u.email from auth.users u where u.id = o.created_by)::text,
    (select count(*) from public.products p where p.organization_id = o.id),
    (select count(*) from public.catalog_listings l where l.organization_id = o.id),
    o.approval_status, o.approval_reason, o.approval_reviewed_at, o.suspended_at,
    count(*) over ()
  from public.organizations o
  where o.kind = 'supplier' and (p_status is null or o.approval_status = p_status)
  order by o.created_at, o.id
  limit greatest(least(coalesce(p_limit, 25), 100), 1)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

/** Aprova (pendente ou reprovado) ou reprova (pendente, com motivo) um fornecedor. */
create function public.admin_review_supplier(p_org uuid, p_approve boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org public.organizations%rowtype;
  v_reason text := nullif(btrim(p_reason), '');
begin
  perform private.require_platform_admin();
  if p_approve is null then
    raise exception 'moderation.invalid';
  end if;
  select * into v_org from public.organizations o where o.id = p_org and o.kind = 'supplier' for update;
  if v_org.id is null then
    raise exception 'moderation.not_found';
  end if;
  if (p_approve and v_org.approval_status = 'approved')
     or (not p_approve and v_org.approval_status <> 'pending') then
    raise exception 'moderation.no_change';
  end if;
  if not p_approve and (v_reason is null or char_length(v_reason) not between 3 and 500) then
    raise exception 'moderation.reason_required';
  end if;

  update public.organizations
  set approval_status = case when p_approve then 'approved'::public.approval_status else 'rejected' end,
      approval_reason = case when p_approve then null else v_reason end,
      approval_reviewed_at = now()
  where id = p_org;

  perform private.audit(
    case when p_approve then 'supplier.approved' else 'supplier.rejected' end,
    p_org, v_org.name, jsonb_build_object('organization_name', v_org.name, 'reason', v_reason)
  );
end;
$$;

create function public.admin_moderation_listings(
  p_status public.listing_moderation,
  p_search text,
  p_limit integer,
  p_offset integer
)
returns table (
  listing_id uuid,
  product_name text,
  description text,
  sku text,
  brand text,
  supplier_id uuid,
  supplier_name text,
  supplier_approval public.approval_status,
  category_id uuid,
  wholesale_price_cents bigint,
  suggested_price_cents bigint,
  is_published boolean,
  product_status public.product_status,
  moderation_status public.listing_moderation,
  moderation_reason text,
  moderated_at timestamptz,
  image_paths text[],
  updated_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_term text := lower(nullif(btrim(coalesce(p_search, '')), ''));
begin
  perform private.require_platform_admin();
  return query
  select l.id, p.name, p.description, p.sku, p.brand, o.id, o.name, o.approval_status,
    l.category_id, l.wholesale_price_cents, l.suggested_price_cents, l.is_published, p.status,
    l.moderation_status, l.moderation_reason, l.moderated_at,
    coalesce((select array_agg(i.storage_path order by i.position)
              from public.product_images i where i.product_id = p.id), '{}'),
    greatest(l.updated_at, p.updated_at),
    count(*) over ()
  from public.catalog_listings l
  join public.products p on p.id = l.product_id
  join public.organizations o on o.id = l.organization_id
  where (p_status is null or l.moderation_status = p_status)
    and (v_term is null
         or position(v_term in lower(p.name)) > 0
         or position(v_term in lower(o.name)) > 0
         or position(v_term in lower(p.sku)) > 0)
  order by greatest(l.updated_at, p.updated_at), l.id
  limit greatest(least(coalesce(p_limit, 20), 50), 1)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

/**
 * approve: pendente/reprovado/bloqueado → aprovado.
 * reject:  pendente/aprovado → reprovado (motivo; o fornecedor pode reenviar).
 * block:   qualquer outro → bloqueado (motivo; só a equipe desfaz).
 */
create function public.admin_moderate_listing(p_listing uuid, p_action text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_listing public.catalog_listings%rowtype;
  v_name text;
  v_reason text := nullif(btrim(p_reason), '');
  v_next public.listing_moderation;
begin
  perform private.require_platform_admin();
  if p_action is null or p_action not in ('approve', 'reject', 'block') then
    raise exception 'moderation.invalid';
  end if;
  select * into v_listing from public.catalog_listings l where l.id = p_listing for update;
  if v_listing.id is null then
    raise exception 'moderation.not_found';
  end if;

  v_next := case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else 'blocked' end;
  if v_listing.moderation_status = v_next
     or (p_action = 'reject' and v_listing.moderation_status = 'blocked') then
    raise exception 'moderation.no_change';
  end if;
  if p_action <> 'approve' and (v_reason is null or char_length(v_reason) not between 3 and 500) then
    raise exception 'moderation.reason_required';
  end if;

  update public.catalog_listings
  set moderation_status = v_next,
      moderation_reason = case when p_action = 'approve' then null else v_reason end,
      moderated_at = now()
  where id = p_listing;

  select p.name into v_name from public.products p where p.id = v_listing.product_id;
  perform private.audit(
    'listing.' || case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else 'blocked' end,
    v_listing.organization_id, v_name,
    jsonb_build_object('listing_id', p_listing, 'reason', v_reason,
      'before', v_listing.moderation_status)
  );
end;
$$;

/** Correção pela equipe: nome, descrição e categoria do anúncio. */
create function public.admin_update_listing_content(
  p_listing uuid,
  p_name text,
  p_description text,
  p_category uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_listing public.catalog_listings%rowtype;
  v_product public.products%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_description text := coalesce(p_description, '');
begin
  perform private.require_platform_admin();
  select * into v_listing from public.catalog_listings l where l.id = p_listing for update;
  if v_listing.id is null then
    raise exception 'moderation.not_found';
  end if;
  select * into v_product from public.products p where p.id = v_listing.product_id for update;
  if char_length(v_name) not between 2 and 200 or char_length(v_description) > 5000 then
    raise exception 'moderation.invalid';
  end if;
  if p_category is not null
     and not exists (select 1 from public.categories c where c.id = p_category and c.is_active)
     and p_category is distinct from v_listing.category_id then
    raise exception 'fees.category_inactive';
  end if;
  if v_name = v_product.name and v_description = v_product.description
     and p_category is not distinct from v_listing.category_id then
    raise exception 'moderation.no_change';
  end if;

  update public.products set name = v_name, description = v_description where id = v_product.id;
  update public.catalog_listings set category_id = p_category where id = p_listing;

  perform private.audit(
    'listing.edited', v_listing.organization_id,
    case when v_name <> v_product.name then v_product.name || ' → ' || v_name else v_name end,
    jsonb_build_object('listing_id', p_listing,
      'before', jsonb_build_object('name', v_product.name, 'description', v_product.description,
                                   'category_id', v_listing.category_id),
      'after', jsonb_build_object('name', v_name, 'description', v_description,
                                  'category_id', p_category))
  );
end;
$$;

-- Indicadores da equipe ganham as filas de moderação.
create or replace function public.admin_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'users', (select count(*) from public.profiles where role <> 'admin'),
    'sellers', (select count(*) from public.organizations where kind = 'seller'),
    'suppliers', (select count(*) from public.organizations where kind = 'supplier'),
    'suspended', (select count(*) from public.organizations where suspended_at is not null),
    'orders_30d', (select count(*) from public.orders
                   where created_at >= now() - interval '30 days' and status <> 'cancelled'),
    'gmv_30d_cents', (select coalesce(sum(total_cents), 0) from public.orders
                      where created_at >= now() - interval '30 days' and status <> 'cancelled'),
    'active_connections', (select count(*) from public.integration_connections
                           where status = 'active'),
    'pending_suppliers', (select count(*) from public.organizations
                          where kind = 'supplier' and approval_status = 'pending'),
    'pending_listings', (select count(*) from public.catalog_listings
                         where moderation_status = 'pending')
  );
end;
$$;

grant execute on function public.resubmit_catalog_listing(uuid) to authenticated;
grant execute on function public.request_supplier_review(uuid) to authenticated;
grant execute on function public.admin_supplier_reviews(public.approval_status, integer, integer) to authenticated;
grant execute on function public.admin_review_supplier(uuid, boolean, text) to authenticated;
grant execute on function public.admin_moderation_listings(public.listing_moderation, text, integer, integer) to authenticated;
grant execute on function public.admin_moderate_listing(uuid, text, text) to authenticated;
grant execute on function public.admin_update_listing_content(uuid, text, text, uuid) to authenticated;
