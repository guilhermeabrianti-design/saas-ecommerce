-- =====================================================================
-- Fase 43 · Campanhas patrocinadas
--
--  * A equipe cadastra pacotes (auditado): onde aparece (Catálogo ou
--    Central de Vendas), por quantos dias, preço e quantas campanhas podem
--    rodar ao mesmo tempo naquele espaço. Nenhum pacote vem cadastrado.
--  * O fornecedor (owner/admin) compra um pacote para um anúncio visível.
--    Pagamento único pelo Mercado Pago (Checkout Pro: PIX, cartão ou
--    boleto), relido sempre na API pela Edge Function `billing`. A
--    campanha começa na aprovação e dura os dias do pacote.
--  * Valor divergente, pagamento duplicado ou espaço esgotado na hora da
--    aprovação: o banco pede estorno. Estorno ou contestação encerram a
--    campanha.
--  * Patrocinados aparecem primeiro, com selo "Patrocinado". Resultados
--    reais: vendedores (empresas) que abriram o anúncio e que importaram
--    o produto durante a campanha.
-- =====================================================================

create type public.sponsorship_placement as enum ('catalog', 'sales_center');
create type public.sponsorship_status as enum ('pending', 'active', 'cancelled', 'refunded');

create table public.sponsorship_packages (
  id uuid primary key default gen_random_uuid(),
  placement public.sponsorship_placement not null,
  name text not null check (char_length(name) between 2 and 60),
  duration_days integer not null check (duration_days between 1 and 90),
  price_cents bigint not null check (price_cents between 100 and 100000000),
  -- Campanhas ao mesmo tempo neste espaço (nulo = sem limite).
  max_active integer check (max_active is null or max_active between 1 and 1000),
  active boolean not null default true,
  position smallint not null default 0,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.sponsored_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  listing_id uuid not null references public.catalog_listings (id) on delete cascade,
  package_id uuid not null references public.sponsorship_packages (id),
  -- Condições do pacote no momento da compra.
  placement public.sponsorship_placement not null,
  duration_days integer not null check (duration_days between 1 and 90),
  price_cents bigint not null check (price_cents >= 100),
  status public.sponsorship_status not null default 'pending',
  checkout_url text check (checkout_url is null or (checkout_url ~ '^https://' and char_length(checkout_url) <= 500)),
  payment_external_id text unique check (payment_external_id is null or payment_external_id ~ '^[0-9]{1,30}$'),
  starts_at timestamptz,
  ends_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'active') = (starts_at is not null and ends_at is not null) or status in ('cancelled', 'refunded'))
);

create index sponsored_campaigns_org_idx on public.sponsored_campaigns (organization_id, created_at desc);
create index sponsored_campaigns_listing_idx on public.sponsored_campaigns (listing_id);
create index sponsored_campaigns_package_idx on public.sponsored_campaigns (package_id);
create index sponsored_campaigns_live_idx on public.sponsored_campaigns (placement, ends_at)
  where status = 'active';
-- Uma compra em andamento por anúncio e espaço.
create unique index sponsored_campaigns_pending_idx
  on public.sponsored_campaigns (listing_id, placement) where status = 'pending';

-- Vendedores (empresas) que abriram o anúncio durante a campanha.
create table public.sponsorship_views (
  campaign_id uuid not null references public.sponsored_campaigns (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (campaign_id, organization_id)
);

create index sponsorship_views_org_idx on public.sponsorship_views (organization_id);

revoke all on table public.sponsorship_packages from anon, authenticated;
revoke all on table public.sponsored_campaigns from anon, authenticated;
revoke all on table public.sponsorship_views from anon, authenticated;
alter table public.sponsorship_packages enable row level security;
alter table public.sponsored_campaigns enable row level security;
alter table public.sponsorship_views enable row level security;

-- ---------------------------------------------------------------------
-- Núcleo
-- ---------------------------------------------------------------------

/** Anúncios patrocinados no ar em um espaço. */
create function private.live_sponsored(p_placement public.sponsorship_placement)
returns table (listing_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct c.listing_id from public.sponsored_campaigns c
  where c.placement = p_placement and c.status = 'active'
    and c.starts_at <= now() and c.ends_at > now()
$$;

/** Campanhas no ar de um pacote (para o limite de vagas). */
create function private.package_live_count(p_package uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.sponsored_campaigns c
  where c.package_id = p_package and c.status = 'active' and c.ends_at > now()
$$;

create function private.listing_visible(p_listing uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.catalog_listings l
    join public.products p on p.id = l.product_id
    join public.organizations o on o.id = l.organization_id
    where l.id = p_listing and l.is_published and p.status = 'active'
      and l.moderation_status = 'approved' and o.suspended_at is null
      and o.approval_status = 'approved'
  )
$$;

-- ---------------------------------------------------------------------
-- Vitrines com patrocinados primeiro
-- ---------------------------------------------------------------------

drop function public.catalog_browse(text, uuid, integer, integer);

create function public.catalog_browse(
  p_query text,
  p_supplier uuid,
  p_limit integer,
  p_offset integer
)
returns table (
  listing_id uuid,
  supplier_id uuid,
  supplier_name text,
  name text,
  brand text,
  wholesale_price_cents bigint,
  suggested_price_cents bigint,
  variant_count integer,
  available integer,
  cover_path text,
  featured boolean,
  sponsored boolean,
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
    with featured as (select e.listing_id from private.effective_featured() e),
    sponsored as (select s.listing_id from private.live_sponsored('catalog') s)
    select
      l.id,
      o.id,
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
      exists (select 1 from featured f where f.listing_id = l.id),
      exists (select 1 from sponsored s where s.listing_id = l.id),
      count(*) over ()
    from public.catalog_listings l
    join public.products p on p.id = l.product_id
    join public.organizations o on o.id = l.organization_id
    where l.is_published and p.status = 'active' and l.moderation_status = 'approved'
      and o.suspended_at is null and o.approval_status = 'approved'
      and (p_supplier is null or o.id = p_supplier)
      and (
        v_term is null
        or p.name ilike '%' || v_term || '%'
        or p.brand ilike '%' || v_term || '%'
        or private.supplier_alias(o.id) ilike '%' || v_term || '%'
      )
    order by exists (select 1 from sponsored s where s.listing_id = l.id) desc,
      exists (select 1 from featured f where f.listing_id = l.id) desc,
      l.updated_at desc, l.id
    limit least(greatest(coalesce(p_limit, 24), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

drop function public.sales_center(text, text, integer, integer);

/** Central de Vendas; fora de "Favoritos", patrocinados vêm primeiro. */
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
  sponsored boolean,
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
  with sponsored as (select s.listing_id from private.live_sponsored('sales_center') s)
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
      private.listing_open_campaigns(l.id),
      exists (select 1 from sponsored sp where sp.listing_id = l.id)
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
       margin_bps, available, cover_path, units_30d, materials, is_favorite, open_campaigns,
       sponsored)
  order by
    case when p_sort <> 'favorites' then s.sponsored end desc nulls last,
    case when p_sort = 'trending' then s.units_30d end desc nulls last,
    case when p_sort = 'margin' then s.margin_bps end desc nulls last,
    (select l2.created_at from public.catalog_listings l2 where l2.id = s.listing_id) desc,
    s.listing_id
  limit least(greatest(coalesce(p_limit, 24), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

/** Vendedor abriu um anúncio: conta uma vez por empresa e campanha no ar. */
create function public.sponsorship_record_view(p_listing uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if not private.is_seller_member() then
    return;
  end if;
  select m.organization_id into v_org from public.organization_members m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = auth.uid() and o.kind = 'seller'
  order by m.created_at limit 1;
  insert into public.sponsorship_views (campaign_id, organization_id)
  select c.id, v_org from public.sponsored_campaigns c
  where c.listing_id = p_listing and c.status = 'active'
    and c.starts_at <= now() and c.ends_at > now()
  on conflict do nothing;
end;
$$;

-- ---------------------------------------------------------------------
-- Fornecedor
-- ---------------------------------------------------------------------

/** Pacotes à venda, anúncios visíveis da empresa e campanhas com resultados. */
create function public.sponsorship_overview(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_org_member(p_org) then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  if (select o.kind from public.organizations o where o.id = p_org) <> 'supplier' then
    raise exception 'sponsorship.suppliers_only';
  end if;

  return jsonb_build_object(
    'can_manage', private.has_org_role(p_org, '{owner,admin}'),
    'packages', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', k.id, 'placement', k.placement, 'name', k.name,
          'duration_days', k.duration_days, 'price_cents', k.price_cents,
          'sold_out', k.max_active is not null and private.package_live_count(k.id) >= k.max_active)
        order by k.placement, k.position, k.price_cents)
      from public.sponsorship_packages k where k.active), '[]'::jsonb),
    'listings', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'name', p.name) order by p.name)
      from public.catalog_listings l join public.products p on p.id = l.product_id
      where l.organization_id = p_org and private.listing_visible(l.id)), '[]'::jsonb),
    'campaigns', coalesce((
      select jsonb_agg(x order by x.created_at desc) from (
        select c.id, c.listing_id, p.name as listing_name, c.placement, k.name as package_name,
          c.duration_days, c.price_cents, c.status, c.checkout_url, c.starts_at, c.ends_at,
          c.created_at,
          (c.status = 'active' and c.ends_at > now()) as live,
          (select count(*)::integer from public.sponsorship_views v where v.campaign_id = c.id) as views,
          (select count(distinct ip.organization_id)::integer from public.products ip
            where ip.source_listing_id = c.listing_id and c.starts_at is not null
              and ip.created_at >= c.starts_at and ip.created_at < c.ends_at) as imports
        from public.sponsored_campaigns c
        join public.catalog_listings l on l.id = c.listing_id
        join public.products p on p.id = l.product_id
        join public.sponsorship_packages k on k.id = c.package_id
        where c.organization_id = p_org
          and (c.status <> 'pending' or c.created_at > now() - interval '7 days')
        order by c.created_at desc limit 50) x), '[]'::jsonb)
  );
end;
$$;

/**
 * Fornecedor escolhe pacote e anúncio. Cria a compra "em andamento" (ou
 * devolve o mesmo link, se já existe para o pacote) com os dados para a
 * Edge Function abrir o pagamento no Mercado Pago.
 */
create function public.sponsorship_begin(p_listing uuid, p_package uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_package public.sponsorship_packages%rowtype;
  v_pending public.sponsored_campaigns%rowtype;
  v_name text;
  v_id uuid;
begin
  select l.organization_id, p.name into v_org, v_name
  from public.catalog_listings l join public.products p on p.id = l.product_id
  where l.id = p_listing;
  if v_org is null or not private.has_org_role(v_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  select * into v_package from public.sponsorship_packages k where k.id = p_package;
  if v_package.id is null or not v_package.active then
    raise exception 'sponsorship.unavailable';
  end if;
  if not private.listing_visible(p_listing) then
    raise exception 'sponsorship.listing_not_visible';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sponsor:' || p_listing::text, 0));
  if exists (select 1 from public.sponsored_campaigns c
             where c.listing_id = p_listing and c.placement = v_package.placement
               and c.status = 'active' and c.ends_at > now()) then
    raise exception 'sponsorship.already_live';
  end if;
  if v_package.max_active is not null
     and private.package_live_count(p_package) >= v_package.max_active then
    raise exception 'sponsorship.sold_out';
  end if;

  select * into v_pending from public.sponsored_campaigns c
  where c.listing_id = p_listing and c.placement = v_package.placement and c.status = 'pending'
  for update;
  if v_pending.id is not null and v_pending.package_id = p_package
     and v_pending.checkout_url is not null and v_pending.created_at > now() - interval '1 day' then
    return jsonb_build_object('campaign_id', v_pending.id, 'checkout_url', v_pending.checkout_url);
  end if;
  -- Outra compra em andamento: o link antigo fica sem efeito (pagamento
  -- tardio dele é estornado).
  if v_pending.id is not null then
    update public.sponsored_campaigns set status = 'cancelled', updated_at = now()
    where id = v_pending.id;
  end if;

  insert into public.sponsored_campaigns
    (organization_id, listing_id, package_id, placement, duration_days, price_cents, created_by)
  values (v_org, p_listing, p_package, v_package.placement, v_package.duration_days,
    v_package.price_cents, auth.uid())
  returning id into v_id;

  return jsonb_build_object(
    'campaign_id', v_id,
    'checkout_url', null,
    'title', left('Patrocínio ' || v_package.name || ' — ' || v_name, 120),
    'price_cents', v_package.price_cents,
    'payer_email', (select u.email from auth.users u where u.id = auth.uid())
  );
end;
$$;

/** Edge Function: grava o link de pagamento criado no Mercado Pago. */
create function public.sponsorship_attach_checkout(p_campaign uuid, p_checkout_url text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.sponsored_campaigns
  set checkout_url = p_checkout_url, updated_at = now()
  where id = p_campaign and status = 'pending' and checkout_url is null;
  if not found then
    raise exception 'sponsorship.not_found';
  end if;
end;
$$;

/** Volta do pagamento: a compra é de uma empresa de quem chamou? */
create function public.sponsorship_is_mine(p_campaign uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.sponsored_campaigns c
    where c.id = p_campaign and private.is_org_member(c.organization_id)
  )
$$;

/**
 * Edge Function: aplica um pagamento lido na API (formato de
 * `checkout_sync_payment`). Devolve 'unknown', 'activated', 'refund_required',
 * 'ended', 'pending' ou 'unchanged'.
 */
create function public.sponsorship_sync_payment(p_payment jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.sponsored_campaigns%rowtype;
  v_package public.sponsorship_packages%rowtype;
  v_status text := p_payment ->> 'status';
  v_payment text := p_payment ->> 'external_id';
  v_amount bigint;
begin
  if p_payment is null or coalesce(v_payment, '') !~ '^[0-9]{1,30}$'
     or coalesce(p_payment ->> 'amount_cents', '') !~ '^[0-9]{1,12}$'
     or v_status is null then
    raise exception 'sponsorship.invalid';
  end if;
  v_amount := (p_payment ->> 'amount_cents')::bigint;
  if coalesce(p_payment ->> 'external_reference', '')
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return 'unknown';
  end if;
  select * into v_c from public.sponsored_campaigns c
  where c.id = (p_payment ->> 'external_reference')::uuid for update;
  if v_c.id is null then
    return 'unknown';
  end if;

  -- Estorno ou contestação do pagamento que ativou: encerra.
  if v_status in ('refunded', 'charged_back') then
    if v_c.payment_external_id = v_payment and v_c.status = 'active' then
      update public.sponsored_campaigns
      set status = 'refunded', ends_at = least(ends_at, now()), updated_at = now()
      where id = v_c.id;
      return 'ended';
    end if;
    return 'unchanged';
  end if;
  if v_status <> 'approved' then
    return 'pending';
  end if;

  if v_c.payment_external_id = v_payment then
    return 'unchanged';
  end if;
  -- Pagou uma compra cancelada, já paga (pagamento duplicado) ou com valor diferente.
  if v_c.status <> 'pending' or v_amount <> v_c.price_cents then
    return 'refund_required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sponsor:' || v_c.listing_id::text, 0));
  select * into v_package from public.sponsorship_packages k where k.id = v_c.package_id;
  if (v_package.max_active is not null
      and private.package_live_count(v_c.package_id) >= v_package.max_active)
     or exists (select 1 from public.sponsored_campaigns c
                where c.listing_id = v_c.listing_id and c.placement = v_c.placement
                  and c.status = 'active' and c.ends_at > now())
     or not private.listing_visible(v_c.listing_id) then
    update public.sponsored_campaigns set status = 'cancelled', updated_at = now()
    where id = v_c.id;
    return 'refund_required';
  end if;

  update public.sponsored_campaigns
  set status = 'active', payment_external_id = v_payment, starts_at = now(),
      ends_at = now() + make_interval(days => v_c.duration_days), updated_at = now()
  where id = v_c.id;
  perform private.notify_org(v_c.organization_id, '{owner,admin}', 'sponsorship.active',
    'Patrocínio no ar',
    'Seu anúncio aparece em destaque por ' || v_c.duration_days || ' dias.', '/patrocinios');
  return 'activated';
end;
$$;

-- ---------------------------------------------------------------------
-- Equipe
-- ---------------------------------------------------------------------

create function public.admin_sponsorship_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'packages', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', k.id, 'placement', k.placement, 'name', k.name,
          'duration_days', k.duration_days, 'price_cents', k.price_cents,
          'max_active', k.max_active, 'active', k.active, 'position', k.position,
          'live', private.package_live_count(k.id))
        order by k.placement, k.position, k.price_cents)
      from public.sponsorship_packages k), '[]'::jsonb),
    'revenue_30d_cents', (select coalesce(sum(c.price_cents), 0)
      from public.sponsored_campaigns c
      where c.status = 'active' and c.starts_at > now() - interval '30 days'),
    'campaigns', coalesce((
      select jsonb_agg(x order by x.created_at desc) from (
        select c.id, private.supplier_display_name(o.id, o.name) as supplier_name,
          p.name as listing_name, c.placement, c.price_cents, c.status, c.starts_at, c.ends_at,
          c.created_at, (c.status = 'active' and c.ends_at > now()) as live
        from public.sponsored_campaigns c
        join public.organizations o on o.id = c.organization_id
        join public.catalog_listings l on l.id = c.listing_id
        join public.products p on p.id = l.product_id
        where c.status <> 'pending'
        order by c.created_at desc limit 100) x), '[]'::jsonb)
  );
end;
$$;

/** Cria (p_id nulo) ou altera um pacote. Mudanças valem para novas compras. */
create function public.admin_save_sponsorship_package(
  p_id uuid,
  p_placement public.sponsorship_placement,
  p_name text,
  p_duration_days integer,
  p_price_cents bigint,
  p_max_active integer,
  p_active boolean,
  p_position smallint
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_platform_admin();
  if char_length(btrim(coalesce(p_name, ''))) not between 2 and 60
     or p_duration_days is null or p_duration_days not between 1 and 90
     or p_price_cents is null or p_price_cents not between 100 and 100000000
     or (p_max_active is not null and p_max_active not between 1 and 1000)
     or p_active is null or (p_id is null and p_placement is null) then
    raise exception 'sponsorship.invalid';
  end if;
  if p_id is null then
    insert into public.sponsorship_packages
      (placement, name, duration_days, price_cents, max_active, active, position, updated_by)
    values (p_placement, btrim(p_name), p_duration_days, p_price_cents, p_max_active, p_active,
      coalesce(p_position, 0), auth.uid())
    returning id into v_id;
  else
    update public.sponsorship_packages
    set name = btrim(p_name), duration_days = p_duration_days, price_cents = p_price_cents,
        max_active = p_max_active, active = p_active, position = coalesce(p_position, position),
        updated_by = auth.uid(), updated_at = now()
    where id = p_id
    returning id into v_id;
    if v_id is null then
      raise exception 'sponsorship.not_found';
    end if;
  end if;
  perform private.audit('sponsorship.package', null, 'Pacote de patrocínio salvo: ' || btrim(p_name),
    jsonb_build_object('package_id', v_id, 'placement', p_placement,
      'duration_days', p_duration_days, 'price_cents', p_price_cents,
      'max_active', p_max_active, 'active', p_active));
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------

revoke execute on function private.live_sponsored(public.sponsorship_placement) from public, anon, authenticated;
revoke execute on function private.package_live_count(uuid) from public, anon, authenticated;
revoke execute on function private.listing_visible(uuid) from public, anon, authenticated;

revoke execute on function public.catalog_browse(text, uuid, integer, integer) from public, anon;
revoke execute on function public.sales_center(text, text, integer, integer) from public, anon;
revoke execute on function public.sponsorship_record_view(uuid) from public, anon;
revoke execute on function public.sponsorship_overview(uuid) from public, anon;
revoke execute on function public.sponsorship_begin(uuid, uuid) from public, anon;
revoke execute on function public.sponsorship_is_mine(uuid) from public, anon;
revoke execute on function public.admin_sponsorship_overview() from public, anon;
revoke execute on function public.admin_save_sponsorship_package(uuid, public.sponsorship_placement, text, integer, bigint, integer, boolean, smallint) from public, anon;
grant execute on function public.catalog_browse(text, uuid, integer, integer) to authenticated;
grant execute on function public.sales_center(text, text, integer, integer) to authenticated;
grant execute on function public.sponsorship_record_view(uuid) to authenticated;
grant execute on function public.sponsorship_overview(uuid) to authenticated;
grant execute on function public.sponsorship_begin(uuid, uuid) to authenticated;
grant execute on function public.sponsorship_is_mine(uuid) to authenticated;
grant execute on function public.admin_sponsorship_overview() to authenticated;
grant execute on function public.admin_save_sponsorship_package(uuid, public.sponsorship_placement, text, integer, bigint, integer, boolean, smallint) to authenticated;

-- Só a Edge Function (service role).
revoke execute on function public.sponsorship_attach_checkout(uuid, text) from public, anon, authenticated;
revoke execute on function public.sponsorship_sync_payment(jsonb) from public, anon, authenticated;
grant execute on function public.sponsorship_attach_checkout(uuid, text) to service_role;
grant execute on function public.sponsorship_sync_payment(jsonb) to service_role;
