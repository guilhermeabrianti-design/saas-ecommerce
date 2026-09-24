-- =====================================================================
-- Fase 19 · Central de Vendas e campanhas para lives
--
--  * Materiais de venda por anúncio do catálogo: vídeo e imagem (arquivo no
--    bucket privado `sales-materials`) e textos prontos (roteiro, título,
--    hashtags, argumentos). Quem escreve: owner/admin do fornecedor dono do
--    anúncio. Vendedores leem só de anúncio visível, por RPC e storage.
--  * Favoritos por usuário (só anúncio visível, só conta vendedora).
--  * Vitrine com abas reais: em alta (unidades em pedidos de fornecimento
--    não cancelados nos últimos 30 dias), maior margem sugerida, novidades
--    e favoritos.
--  * Campanhas para lives (equipe): período, produtos, marketplace opcional
--    e comissão própria do vendedor. O vendedor participa; enquanto a
--    campanha está no ar, a comissão dela vale para os produtos incluídos
--    (precedência sobre produto/vendedor/categoria/padrão; se houver mais
--    de uma, a maior). Tudo auditado.
-- =====================================================================

create type public.sales_material_kind as enum ('video', 'image', 'script', 'title', 'hashtags', 'argument');
create type public.live_campaign_status as enum ('draft', 'published', 'cancelled');

-- FK composta: material sempre pertence à organização dona do anúncio.
alter table public.catalog_listings
  add constraint catalog_listings_org_id_key unique (organization_id, id);

-- ---------------------------------------------------------------------
-- Materiais de venda
-- ---------------------------------------------------------------------
create table public.sales_materials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  listing_id uuid not null,
  kind public.sales_material_kind not null,
  title text not null check (title = btrim(title) and char_length(title) between 2 and 120),
  body text check (body is null or char_length(btrim(body)) between 1 and 5000),
  storage_path text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (organization_id, listing_id)
    references public.catalog_listings (organization_id, id) on delete cascade,
  check (
    (kind in ('video', 'image') and body is null
      and storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[^/]{1,120}$'
      and split_part(storage_path, '/', 1) = listing_id::text)
    or (kind not in ('video', 'image') and storage_path is null and body is not null)
  )
);

create index sales_materials_listing_idx on public.sales_materials (listing_id, created_at);

/** Owner/admin do fornecedor (ou a equipe) gerencia os materiais do anúncio. */
create function private.can_manage_listing(p_listing uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_platform_admin() or exists (
    select 1 from public.catalog_listings l
    where l.id = p_listing and private.has_org_role(l.organization_id, '{owner,admin}')
  )
$$;

grant execute on function private.can_manage_listing(uuid) to authenticated;

-- Limite por anúncio (evita abuso do espaço e da vitrine).
create function private.sales_materials_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from public.sales_materials m where m.listing_id = new.listing_id) >= 50 then
    raise exception 'sales.too_many_materials';
  end if;
  return new;
end;
$$;

create trigger sales_materials_limit
  before insert on public.sales_materials
  for each row execute function private.sales_materials_limit();

revoke all on table public.sales_materials from anon, authenticated;
grant select, delete on table public.sales_materials to authenticated;
grant insert (organization_id, listing_id, kind, title, body, storage_path)
  on table public.sales_materials to authenticated;
grant update (title, body) on table public.sales_materials to authenticated;

alter table public.sales_materials enable row level security;

create policy "sales_materials: membros do fornecedor e equipe leem"
  on public.sales_materials for select to authenticated
  using (private.is_org_member(organization_id) or private.is_platform_admin());

create policy "sales_materials: owner/admin do fornecedor cria"
  on public.sales_materials for insert to authenticated
  with check (private.can_manage_listing(listing_id));

create policy "sales_materials: owner/admin do fornecedor edita"
  on public.sales_materials for update to authenticated
  using (private.can_manage_listing(listing_id))
  with check (private.can_manage_listing(listing_id));

create policy "sales_materials: owner/admin do fornecedor e equipe excluem"
  on public.sales_materials for delete to authenticated
  using (private.can_manage_listing(listing_id));

-- Storage: <anúncio>/<uuid>/<arquivo>
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sales-materials', 'sales-materials', false, 104857600,
        array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm'])
on conflict (id) do nothing;

create function private.sales_material_listing(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(p_name, '/', 1)::uuid end
$$;

create function private.sales_file_readable(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_platform_admin() or exists (
    select 1 from public.catalog_listings l
    where l.id = private.sales_material_listing(p_name)
      and (private.is_org_member(l.organization_id)
           or (private.is_seller_member() and private.visible_listing(l.id)))
  )
$$;

grant execute on function private.sales_material_listing(text) to authenticated;
grant execute on function private.sales_file_readable(text) to authenticated;

create policy "sales-materials: leitura conforme anúncio"
  on storage.objects for select to authenticated
  using (bucket_id = 'sales-materials' and private.sales_file_readable(name));

create policy "sales-materials: fornecedor envia"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'sales-materials'
    and private.can_manage_listing(private.sales_material_listing(name)));

create policy "sales-materials: fornecedor e equipe excluem"
  on storage.objects for delete to authenticated
  using (bucket_id = 'sales-materials'
    and private.can_manage_listing(private.sales_material_listing(name)));

-- ---------------------------------------------------------------------
-- Favoritos
-- ---------------------------------------------------------------------
create table public.listing_favorites (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  listing_id uuid not null references public.catalog_listings (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, listing_id)
);

revoke all on table public.listing_favorites from anon, authenticated;
grant select, delete on table public.listing_favorites to authenticated;
grant insert (listing_id) on table public.listing_favorites to authenticated;

alter table public.listing_favorites enable row level security;

-- Usado na policy de inserção abaixo.
grant execute on function private.visible_listing(uuid) to authenticated;

create policy "listing_favorites: usuário lê os seus"
  on public.listing_favorites for select to authenticated
  using (user_id = (select auth.uid()));

create policy "listing_favorites: vendedor favorita anúncio visível"
  on public.listing_favorites for insert to authenticated
  with check (user_id = (select auth.uid()) and private.is_seller_member()
    and private.visible_listing(listing_id));

create policy "listing_favorites: usuário remove os seus"
  on public.listing_favorites for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- Campanhas para lives (sem acesso direto: só RPCs)
-- ---------------------------------------------------------------------
create table public.live_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null check (name = btrim(name) and char_length(name) between 3 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  provider public.marketplace_provider,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  commission_bps integer check (commission_bps is null or commission_bps between 0 and 10000),
  status public.live_campaign_status not null default 'draft',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at and ends_at - starts_at <= interval '90 days')
);

create trigger live_campaigns_set_updated_at
  before update on public.live_campaigns
  for each row execute function public.set_updated_at();

create table public.live_campaign_listings (
  campaign_id uuid not null references public.live_campaigns (id) on delete cascade,
  listing_id uuid not null references public.catalog_listings (id) on delete cascade,
  primary key (campaign_id, listing_id)
);

create index live_campaign_listings_listing_idx on public.live_campaign_listings (listing_id);

create table public.live_campaign_participants (
  campaign_id uuid not null references public.live_campaigns (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  joined_by uuid,
  joined_at timestamptz not null default now(),
  primary key (campaign_id, organization_id)
);

create index live_campaign_participants_org_idx on public.live_campaign_participants (organization_id);

do $$
declare
  t text;
begin
  foreach t in array array['live_campaigns', 'live_campaign_listings', 'live_campaign_participants'] loop
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- Comissão: a campanha no ar tem precedência
-- ---------------------------------------------------------------------
create function private.seller_commission(
  p_listing uuid,
  p_category uuid,
  p_seller uuid,
  p_provider public.marketplace_provider
)
returns table (percent_bps integer, source text)
language sql
stable
security definer
set search_path = ''
as $$
  select t.percent_bps, t.source from (
    select c.commission_bps as percent_bps, 'live_campaign'::text as source, 0 as prio
    from public.live_campaigns c
    join public.live_campaign_listings cl on cl.campaign_id = c.id and cl.listing_id = p_listing
    join public.live_campaign_participants cp on cp.campaign_id = c.id and cp.organization_id = p_seller
    where c.status = 'published' and c.commission_bps is not null
      and now() >= c.starts_at and now() < c.ends_at
      and (c.provider is null or c.provider = p_provider)
    union all
    select r.percent_bps, r.source, 1
    from private.seller_commission(p_listing, p_category, p_seller) r
  ) t
  order by t.prio, t.percent_bps desc
  limit 1
$$;

create or replace function private.compute_split(
  p_provider public.marketplace_provider,
  p_listing_type text,
  p_campaign text,
  p_category uuid,
  p_listing uuid,
  p_seller uuid,
  p_unit_cents bigint,
  p_quantity integer,
  p_supplier_unit_cents bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_type text := nullif(btrim(p_listing_type), '');
  v_campaign text := nullif(btrim(p_campaign), '');
  v_base public.marketplace_fee_rules%rowtype;
  v_extra public.marketplace_fee_rules%rowtype;
  v_sale bigint;
  v_fee bigint;
  v_supplier bigint;
  v_commission_bps integer;
  v_commission_source text;
  v_commission bigint;
  v_platform bigint;
begin
  if p_provider is null or v_type is null
     or p_unit_cents is null or p_unit_cents not between 1 and 100000000000
     or p_quantity is null or p_quantity not between 1 and 10000
     or p_supplier_unit_cents is null or p_supplier_unit_cents not between 0 and 100000000000 then
    raise exception 'fees.invalid';
  end if;

  v_base := private.match_fee_rule(p_provider, v_type, p_category, null, p_unit_cents);
  if v_base.id is null then
    raise exception 'fees.not_configured';
  end if;
  if v_campaign is not null then
    v_extra := private.match_fee_rule(p_provider, v_type, p_category, v_campaign, p_unit_cents);
    if v_extra.id is null then
      raise exception 'fees.campaign_not_configured';
    end if;
  end if;

  select s.percent_bps, s.source into v_commission_bps, v_commission_source
  from private.seller_commission(p_listing, p_category, p_seller, p_provider) s;
  if v_commission_bps is null then
    raise exception 'fees.commission_not_configured';
  end if;

  v_sale := p_unit_cents * p_quantity;
  v_fee := private.percent_of(v_sale, v_base.percent_bps) + v_base.fixed_cents_per_item * p_quantity
    + coalesce(private.percent_of(v_sale, v_extra.percent_bps) + v_extra.fixed_cents_per_item * p_quantity, 0);
  v_supplier := p_supplier_unit_cents * p_quantity;
  v_commission := private.percent_of(v_sale, v_commission_bps);
  v_platform := v_sale - v_fee - v_supplier - v_commission;

  return jsonb_build_object(
    'unit_price_cents', p_unit_cents,
    'quantity', p_quantity,
    'sale_cents', v_sale,
    'marketplace_fee_cents', v_fee,
    'fee_rule', jsonb_build_object(
      'id', v_base.id, 'label', v_base.label,
      'percent_bps', v_base.percent_bps, 'fixed_cents_per_item', v_base.fixed_cents_per_item),
    'campaign_rule', case when v_extra.id is null then null else jsonb_build_object(
      'id', v_extra.id, 'label', v_extra.label, 'campaign', v_extra.campaign,
      'percent_bps', v_extra.percent_bps, 'fixed_cents_per_item', v_extra.fixed_cents_per_item) end,
    'supplier_cents', v_supplier,
    'seller_commission_bps', v_commission_bps,
    'seller_commission_source', v_commission_source,
    'seller_commission_cents', v_commission,
    'platform_cents', v_platform,
    'platform_margin_bps', round(v_platform::numeric * 10000 / v_sale)::integer
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Vitrine (vendedores)
-- ---------------------------------------------------------------------

/** Unidades do anúncio em pedidos de fornecimento não cancelados, nos últimos 30 dias. */
create function private.listing_units_30d(p_listing uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(soi.quantity), 0)::integer
  from public.catalog_listings l
  join public.inventory_items ii on ii.product_id = l.product_id
  join public.supplier_order_items soi on soi.inventory_item_id = ii.id
  join public.supplier_orders so on so.id = soi.supplier_order_id
  where l.id = p_listing and so.status <> 'cancelled' and so.created_at >= now() - interval '30 days'
$$;

/** Campanhas publicadas que ainda não terminaram e incluem o anúncio. */
create function private.listing_open_campaigns(p_listing uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.live_campaign_listings cl
  join public.live_campaigns c on c.id = cl.campaign_id
  where cl.listing_id = p_listing and c.status = 'published' and c.ends_at > now()
$$;

create function public.sales_center(p_sort text, p_query text, p_limit integer, p_offset integer)
returns table (
  listing_id uuid,
  name text,
  brand text,
  supplier_name text,
  wholesale_price_cents bigint,
  suggested_price_cents bigint,
  margin_bps integer,
  available integer,
  cover_path text,
  units_30d integer,
  materials integer,
  is_favorite boolean,
  open_campaigns integer,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_term text := nullif(btrim(coalesce(p_query, '')), '');
begin
  if not private.is_seller_member() then
    raise exception 'catalog.sellers_only' using errcode = '42501';
  end if;
  if p_sort is null or p_sort not in ('trending', 'margin', 'new', 'favorites') then
    raise exception 'sales.invalid_sort';
  end if;

  return query
  select s.*, count(*) over ()
  from (
    select
      l.id,
      p.name,
      p.brand,
      o.name,
      l.wholesale_price_cents,
      l.suggested_price_cents,
      case when l.suggested_price_cents > 0 then
        ((l.suggested_price_cents - l.wholesale_price_cents) * 10000 / l.suggested_price_cents)::integer end,
      (select coalesce(sum(il.available), 0)::integer from public.inventory_levels il
        where il.product_id = p.id and il.is_active),
      (select i.storage_path from public.product_images i
        where i.product_id = p.id order by i.position limit 1),
      private.listing_units_30d(l.id),
      (select count(*)::integer from public.sales_materials m where m.listing_id = l.id),
      f.listing_id is not null,
      private.listing_open_campaigns(l.id)
    from public.catalog_listings l
    join public.products p on p.id = l.product_id
    join public.organizations o on o.id = l.organization_id
    left join public.listing_favorites f on f.listing_id = l.id and f.user_id = v_uid
    where l.is_published and p.status = 'active' and l.moderation_status = 'approved'
      and o.suspended_at is null and o.approval_status = 'approved'
      and (p_sort <> 'favorites' or f.listing_id is not null)
      and (
        v_term is null
        or p.name ilike '%' || v_term || '%'
        or p.brand ilike '%' || v_term || '%'
        or o.name ilike '%' || v_term || '%'
      )
  ) s (listing_id, name, brand, supplier_name, wholesale_price_cents, suggested_price_cents,
       margin_bps, available, cover_path, units_30d, materials, is_favorite, open_campaigns)
  order by
    case when p_sort = 'trending' then s.units_30d end desc nulls last,
    case when p_sort = 'margin' then s.margin_bps end desc nulls last,
    (select l2.created_at from public.catalog_listings l2 where l2.id = s.listing_id) desc,
    s.listing_id
  limit least(greatest(coalesce(p_limit, 24), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

/** Materiais e campanhas abertas de um anúncio visível. */
create function public.sales_center_listing(p_listing uuid)
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
    'name', p.name,
    'brand', p.brand,
    'description', p.description,
    'supplier_name', o.name,
    'wholesale_price_cents', l.wholesale_price_cents,
    'suggested_price_cents', l.suggested_price_cents,
    'units_30d', private.listing_units_30d(l.id),
    'is_favorite', exists (select 1 from public.listing_favorites f
                           where f.listing_id = l.id and f.user_id = auth.uid()),
    'materials', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'kind', m.kind, 'title', m.title, 'body', m.body, 'storage_path', m.storage_path)
        order by m.created_at, m.id)
      from public.sales_materials m where m.listing_id = l.id), '[]'::jsonb),
    'campaigns', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'provider', c.provider, 'starts_at', c.starts_at,
        'ends_at', c.ends_at, 'commission_bps', c.commission_bps)
        order by c.starts_at, c.id)
      from public.live_campaign_listings cl
      join public.live_campaigns c on c.id = cl.campaign_id
      where cl.listing_id = l.id and c.status = 'published' and c.ends_at > now()), '[]'::jsonb)
  ) into v_result
  from public.catalog_listings l
  join public.products p on p.id = l.product_id
  join public.organizations o on o.id = l.organization_id
  where l.id = p_listing;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------
-- Campanhas: vendedor
-- ---------------------------------------------------------------------
create function private.require_seller_member(p_org uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_org_member(p_org) or private.org_kind(p_org) <> 'seller' then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
end;
$$;

create function public.live_campaigns_for_seller(p_org uuid)
returns table (
  id uuid,
  name text,
  description text,
  provider public.marketplace_provider,
  starts_at timestamptz,
  ends_at timestamptz,
  commission_bps integer,
  listings integer,
  joined boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_seller_member(p_org);
  return query
  select c.id, c.name, c.description, c.provider, c.starts_at, c.ends_at, c.commission_bps,
    (select count(*)::integer from public.live_campaign_listings cl
      where cl.campaign_id = c.id and private.visible_listing(cl.listing_id)),
    exists (select 1 from public.live_campaign_participants cp
            where cp.campaign_id = c.id and cp.organization_id = p_org)
  from public.live_campaigns c
  where c.status = 'published' and c.ends_at > now()
  order by c.starts_at, c.id;
end;
$$;

create function public.live_campaign_for_seller(p_org uuid, p_campaign uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.require_seller_member(p_org);

  select jsonb_build_object(
    'id', c.id, 'name', c.name, 'description', c.description, 'provider', c.provider,
    'starts_at', c.starts_at, 'ends_at', c.ends_at, 'commission_bps', c.commission_bps,
    'joined', exists (select 1 from public.live_campaign_participants cp
                      where cp.campaign_id = c.id and cp.organization_id = p_org),
    'listings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'listing_id', l.id, 'name', p.name, 'supplier_name', o.name,
        'wholesale_price_cents', l.wholesale_price_cents,
        'suggested_price_cents', l.suggested_price_cents,
        'available', (select coalesce(sum(il.available), 0) from public.inventory_levels il
                      where il.product_id = p.id and il.is_active),
        'cover_path', (select i.storage_path from public.product_images i
                       where i.product_id = p.id order by i.position limit 1),
        'materials', (select count(*) from public.sales_materials m where m.listing_id = l.id))
        order by p.name, l.id)
      from public.live_campaign_listings cl
      join public.catalog_listings l on l.id = cl.listing_id
      join public.products p on p.id = l.product_id
      join public.organizations o on o.id = l.organization_id
      where cl.campaign_id = c.id and private.visible_listing(l.id)), '[]'::jsonb)
  ) into v_result
  from public.live_campaigns c
  where c.id = p_campaign and c.status = 'published' and c.ends_at > now();

  if v_result is null then
    raise exception 'campaign.not_found';
  end if;
  return v_result;
end;
$$;

/** Entrar (ou sair) de uma campanha publicada que ainda não terminou. Owner/admin. */
create function public.set_live_campaign_participation(p_org uuid, p_campaign uuid, p_join boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign public.live_campaigns%rowtype;
begin
  if not private.has_org_role(p_org, '{owner,admin}') or private.org_kind(p_org) <> 'seller' then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  select * into v_campaign from public.live_campaigns c where c.id = p_campaign for share;
  if v_campaign.id is null or v_campaign.status <> 'published' then
    raise exception 'campaign.not_found';
  end if;
  if v_campaign.ends_at <= now() then
    raise exception 'campaign.ended';
  end if;

  if coalesce(p_join, false) then
    insert into public.live_campaign_participants (campaign_id, organization_id, joined_by)
    values (p_campaign, p_org, auth.uid())
    on conflict do nothing;
  else
    delete from public.live_campaign_participants cp
    where cp.campaign_id = p_campaign and cp.organization_id = p_org;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Campanhas: equipe
-- ---------------------------------------------------------------------
create function public.admin_live_campaigns()
returns table (
  id uuid,
  name text,
  provider public.marketplace_provider,
  starts_at timestamptz,
  ends_at timestamptz,
  commission_bps integer,
  status public.live_campaign_status,
  listings integer,
  participants integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return query
  select c.id, c.name, c.provider, c.starts_at, c.ends_at, c.commission_bps, c.status,
    (select count(*)::integer from public.live_campaign_listings cl where cl.campaign_id = c.id),
    (select count(*)::integer from public.live_campaign_participants cp where cp.campaign_id = c.id)
  from public.live_campaigns c
  order by c.starts_at desc, c.id;
end;
$$;

create function public.admin_live_campaign(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.require_platform_admin();
  select jsonb_build_object(
    'id', c.id, 'name', c.name, 'description', c.description, 'provider', c.provider,
    'starts_at', c.starts_at, 'ends_at', c.ends_at, 'commission_bps', c.commission_bps,
    'status', c.status,
    'listings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'listing_id', l.id, 'product_name', p.name, 'supplier_name', o.name,
        'is_published', l.is_published) order by p.name, l.id)
      from public.live_campaign_listings cl
      join public.catalog_listings l on l.id = cl.listing_id
      join public.products p on p.id = l.product_id
      join public.organizations o on o.id = l.organization_id
      where cl.campaign_id = c.id), '[]'::jsonb),
    'participants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'organization_id', o.id, 'organization_name', o.name, 'joined_at', cp.joined_at)
        order by cp.joined_at, o.id)
      from public.live_campaign_participants cp
      join public.organizations o on o.id = cp.organization_id
      where cp.campaign_id = c.id), '[]'::jsonb)
  ) into v_result
  from public.live_campaigns c
  where c.id = p_id;

  if v_result is null then
    raise exception 'campaign.not_found';
  end if;
  return v_result;
end;
$$;

/**
 * Cria (p_id nulo) ou altera uma campanha, com a lista completa de anúncios.
 * p_data: name, description, provider, starts_at, ends_at, commission_bps, status, listing_ids.
 */
create function public.admin_save_live_campaign(p_id uuid, p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := p_id;
  v_name text;
  v_description text;
  v_provider public.marketplace_provider;
  v_starts timestamptz;
  v_ends timestamptz;
  v_bps integer;
  v_status public.live_campaign_status;
  v_listings uuid[];
  v_before public.live_campaigns%rowtype;
begin
  perform private.require_platform_admin();
  if p_data is null or jsonb_typeof(p_data) <> 'object'
     or jsonb_typeof(coalesce(p_data -> 'listing_ids', '[]'::jsonb)) <> 'array' then
    raise exception 'campaign.invalid';
  end if;

  begin
    v_name := btrim(p_data ->> 'name');
    v_description := coalesce(btrim(p_data ->> 'description'), '');
    v_provider := nullif(p_data ->> 'provider', '')::public.marketplace_provider;
    v_starts := (p_data ->> 'starts_at')::timestamptz;
    v_ends := (p_data ->> 'ends_at')::timestamptz;
    v_bps := (p_data ->> 'commission_bps')::integer;
    v_status := coalesce(p_data ->> 'status', 'draft')::public.live_campaign_status;
    v_listings := array(select distinct x::uuid
                        from jsonb_array_elements_text(coalesce(p_data -> 'listing_ids', '[]'::jsonb)) x);
  exception when others then
    raise exception 'campaign.invalid';
  end;

  if v_name is null or char_length(v_name) not between 3 and 120
     or char_length(v_description) > 2000
     or v_starts is null or v_ends is null or v_ends <= v_starts
     or v_ends - v_starts > interval '90 days'
     or (v_bps is not null and v_bps not between 0 and 10000)
     or cardinality(v_listings) > 200 then
    raise exception 'campaign.invalid';
  end if;
  if exists (select 1 from unnest(v_listings) x
             where not exists (select 1 from public.catalog_listings l where l.id = x)) then
    raise exception 'campaign.listing_not_found';
  end if;
  if v_status = 'published' and cardinality(v_listings) = 0 then
    raise exception 'campaign.no_listings';
  end if;

  if v_id is null then
    insert into public.live_campaigns
      (name, description, provider, starts_at, ends_at, commission_bps, status, created_by)
    values (v_name, v_description, v_provider, v_starts, v_ends, v_bps, v_status, auth.uid())
    returning id into v_id;
  else
    select * into v_before from public.live_campaigns c where c.id = v_id for update;
    if v_before.id is null then
      raise exception 'campaign.not_found';
    end if;
    update public.live_campaigns c set
      name = v_name, description = v_description, provider = v_provider,
      starts_at = v_starts, ends_at = v_ends, commission_bps = v_bps, status = v_status
    where c.id = v_id;
    delete from public.live_campaign_listings cl
    where cl.campaign_id = v_id and cl.listing_id <> all (v_listings);
  end if;

  insert into public.live_campaign_listings (campaign_id, listing_id)
  select v_id, x from unnest(v_listings) x
  on conflict do nothing;

  perform private.audit(
    case when p_id is null then 'live_campaign.created' else 'live_campaign.updated' end,
    null,
    v_name || ' · ' || v_status::text
      || coalesce(' · comissão ' || round(v_bps / 100.0, 2)::text || '%', ' · comissão das regras'),
    jsonb_build_object('campaign_id', v_id, 'listings', cardinality(v_listings),
      'before', case when v_before.id is null then null else jsonb_build_object(
        'status', v_before.status, 'commission_bps', v_before.commission_bps,
        'starts_at', v_before.starts_at, 'ends_at', v_before.ends_at) end)
  );
  return v_id;
end;
$$;

grant execute on function public.sales_center(text, text, integer, integer) to authenticated;
grant execute on function public.sales_center_listing(uuid) to authenticated;
grant execute on function public.live_campaigns_for_seller(uuid) to authenticated;
grant execute on function public.live_campaign_for_seller(uuid, uuid) to authenticated;
grant execute on function public.set_live_campaign_participation(uuid, uuid, boolean) to authenticated;
grant execute on function public.admin_live_campaigns() to authenticated;
grant execute on function public.admin_live_campaign(uuid) to authenticated;
grant execute on function public.admin_save_live_campaign(uuid, jsonb) to authenticated;
