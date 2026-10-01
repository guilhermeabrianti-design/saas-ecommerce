-- =====================================================================
-- Fase 33 · Ambientes separados e só Mercado Livre, Shopee e TikTok Shop
--
--  * Vendedor e fornecedor não se identificam: o vendedor vê o fornecedor
--    por um apelido estável ("Fornecedor 3F9A1C") — dá para comparar
--    reputação e produtos sem saber quem é —, e o fornecedor já via só
--    "Vendedor verificado". O nome real fica para a própria organização e
--    para a equipe. A busca do catálogo não procura mais pelo nome real.
--  * Shopify e WooCommerce saem: conexões manuais por webhook, segredos,
--    credenciais de API e o gerenciador de anúncios (que só publicava
--    nelas). Os valores continuam no enum (Postgres não remove valores),
--    mas as tabelas passam a recusá-los.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Apelido do fornecedor
-- ---------------------------------------------------------------------

/** "Fornecedor XXXXXX": estável por organização e sem revelar o id. */
create function private.supplier_alias(p_org uuid)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'Fornecedor ' || upper(substr(md5('thesigns-supplier:' || p_org::text), 1, 6))
$$;

/** Nome real para a própria organização e para a equipe; apelido para os demais. */
create function private.supplier_display_name(p_org uuid, p_name text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.is_org_member(p_org) or private.is_platform_admin() then p_name
    else private.supplier_alias(p_org)
  end
$$;

revoke execute on function private.supplier_alias(uuid) from public, anon, authenticated;
revoke execute on function private.supplier_display_name(uuid, text) from public, anon, authenticated;

-- search_catalog: fornecedor pelo apelido.
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
      private.supplier_display_name(o.id, o.name),
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
        or private.supplier_alias(o.id) ilike '%' || v_term || '%'
      )
    order by l.updated_at desc, l.id
    limit least(greatest(coalesce(p_limit, 24), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- get_catalog_listing: fornecedor pelo apelido.
create or replace function public.get_catalog_listing(p_listing uuid)
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
    'supplier_name', private.supplier_display_name(o.id, o.name),
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
    'category_name', (select coalesce(pc.name || ' › ', '') || c.name from public.categories c
                      left join public.categories pc on pc.id = c.parent_id where c.id = l.category_id),
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

-- seller_suggestions: fornecedor pelo apelido.
create or replace function public.seller_suggestions(p_org uuid, p_limit integer)
returns table (
  listing_id uuid,
  name text,
  supplier_name text,
  wholesale_price_cents bigint,
  suggested_price_cents bigint,
  margin_bps integer,
  available integer,
  cover_path text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_org_member(p_org) or private.org_kind(p_org) <> 'seller' then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;

  return query
  select * from (
    select
      l.id,
      p.name,
      private.supplier_display_name(o.id, o.name),
      l.wholesale_price_cents,
      l.suggested_price_cents,
      ((l.suggested_price_cents - l.wholesale_price_cents) * 10000 / l.suggested_price_cents)::integer,
      (select coalesce(sum(il.available), 0)::integer from public.inventory_levels il
        where il.product_id = p.id and il.is_active),
      (select i.storage_path from public.product_images i
        where i.product_id = p.id order by i.position limit 1)
    from public.catalog_listings l
    join public.products p on p.id = l.product_id
    join public.organizations o on o.id = l.organization_id
    where l.is_published and p.status = 'active' and l.moderation_status = 'approved'
      and o.suspended_at is null and o.approval_status = 'approved'
      and l.suggested_price_cents > l.wholesale_price_cents
      and not exists (
        select 1 from public.products mine
        where mine.organization_id = p_org and mine.source_listing_id = l.id)
  ) s (listing_id, name, supplier_name, wholesale_price_cents, suggested_price_cents, margin_bps, available, cover_path)
  where s.available > 0
  order by s.margin_bps desc, s.suggested_price_cents - s.wholesale_price_cents desc, s.listing_id
  limit least(greatest(coalesce(p_limit, 5), 1), 20);
end;
$$;

-- sales_center: fornecedor pelo apelido.
create or replace function public.sales_center(p_sort text, p_query text, p_limit integer, p_offset integer)
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
      private.supplier_display_name(o.id, o.name),
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
        or private.supplier_alias(o.id) ilike '%' || v_term || '%'
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

-- sales_center_listing: fornecedor pelo apelido.
create or replace function public.sales_center_listing(p_listing uuid)
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
    'supplier_name', private.supplier_display_name(o.id, o.name),
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

-- live_campaign_for_seller: fornecedor pelo apelido.
create or replace function public.live_campaign_for_seller(p_org uuid, p_campaign uuid)
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
        'listing_id', l.id, 'name', p.name, 'supplier_name', private.supplier_display_name(o.id, o.name),
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

-- Reputação: o vendedor vê o fornecedor pelo apelido.
create or replace function public.organization_reputation(p_org uuid, p_limit integer, p_offset integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (
    private.is_org_member(p_org) or private.is_platform_admin() or exists (
      select 1 from public.organizations o
      where o.id = p_org and o.kind = 'supplier' and o.suspended_at is null
        and o.approval_status = 'approved'
    )
  ) then
    raise exception 'reviews.not_found';
  end if;
  return private.org_reputation(p_org) || jsonb_build_object(
    'name', (select private.supplier_display_name(o.id, o.name) from public.organizations o where o.id = p_org),
    'can_reply', private.has_org_role(p_org, '{owner,admin}'),
    'reviews', private.org_reviews(p_org, p_limit, p_offset)
  );
end;
$$;

create or replace function public.listing_supplier_reputation(p_listing uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if not private.visible_listing(p_listing) then
    raise exception 'reviews.not_found';
  end if;
  select l.organization_id into v_org from public.catalog_listings l where l.id = p_listing;
  return private.org_reputation(v_org) || jsonb_build_object(
    'name', (select private.supplier_display_name(o.id, o.name) from public.organizations o where o.id = v_org),
    'can_reply', false,
    'reviews', private.org_reviews(v_org, 5, 0)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Fora: Shopify e WooCommerce
-- ---------------------------------------------------------------------

-- Gerenciador de anúncios (publicava só em Shopify/WooCommerce).
drop function public.save_channel_listing(uuid, uuid, uuid, uuid, text, text, bigint);
drop function public.duplicate_channel_listing(uuid, uuid);
drop function public.delete_channel_listing(uuid);
drop function public.channel_listing_begin(uuid, text);
drop function public.channel_listing_step(uuid, uuid, text, text, text);
drop function public.channel_listing_finish(uuid, uuid, boolean, text, text, text, jsonb);
drop function private.publishable_connection(uuid, uuid);
drop table public.channel_listing_steps;
drop table public.channel_listings;
drop type public.channel_listing_status;

-- Conexão manual por webhook e credenciais de API.
drop function public.create_connection(uuid, public.marketplace_provider, text, text, text);
drop function public.rotate_connection_secret(uuid, text);
drop function public.store_connection_credentials(uuid, text, smallint, jsonb);
drop function public.connection_credentials_status(uuid);

create or replace function public.set_connection_status(p_connection uuid, p_status public.connection_status)
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
    delete from public.integration_credentials where connection_id = p_connection;
    -- Nada de estoque pendente para uma conexão encerrada.
    delete from public.stock_sync_outbox o using public.listing_links l
    where o.link_id = l.id and l.connection_id = p_connection and o.done_at is null;
  end if;
  update public.integration_connections set status = p_status where id = p_connection;
end;
$$;

drop table public.integration_secrets;

delete from public.integration_connections where provider in ('shopify', 'woocommerce');
delete from public.marketplace_fee_rules where provider in ('shopify', 'woocommerce');
update public.live_campaigns set provider = null where provider in ('shopify', 'woocommerce');

alter table public.integration_connections
  add constraint integration_connections_supported_provider
  check (provider in ('mercadolivre', 'shopee', 'tiktok'));
alter table public.oauth_states
  add constraint oauth_states_supported_provider
  check (provider in ('mercadolivre', 'shopee', 'tiktok'));
alter table public.marketplace_fee_rules
  add constraint marketplace_fee_rules_supported_provider
  check (provider in ('mercadolivre', 'shopee', 'tiktok'));
alter table public.live_campaigns
  add constraint live_campaigns_supported_provider
  check (provider is null or provider in ('mercadolivre', 'shopee', 'tiktok'));
