-- =====================================================================
-- Fase 42 · Planos e monetização
--
--  * Planos por tipo de conta (vendedor / fornecedor), cadastrados pela
--    equipe (auditado). Cada tipo tem um plano gratuito padrão; planos
--    pagos nascem pelo painel — nenhum preço vem fixo no código.
--  * O plano define limites reais: gerações de IA por dia (nulo = padrão
--    da plataforma), produtos ativos (nulo = sem limite) e vagas de
--    destaque no catálogo (fornecedor).
--  * Assinatura recorrente mensal pelo Mercado Pago (preapproval). O
--    estado vem sempre da API (Edge Function `billing`); o banco guarda o
--    preço do momento da assinatura (mudar o preço do plano vale para
--    novas assinaturas).
--  * Cancelou: o plano vale até a próxima cobrança que não vai acontecer.
--    Trocou de plano: o novo vale na autorização e o antigo é cancelado.
--  * Destaque de produto: o fornecedor marca anúncios até o número de
--    vagas do plano; destacados aparecem primeiro no catálogo com selo.
--    Se o plano cair, só os primeiros marcados (até as vagas) contam.
-- =====================================================================

create type public.subscription_status as enum ('pending', 'authorized', 'paused', 'cancelled');

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  org_kind public.org_kind not null,
  name text not null check (char_length(name) between 2 and 60),
  description text check (description is null or char_length(description) <= 300),
  price_cents bigint not null check (price_cents between 0 and 100000000),
  ai_daily_limit integer check (ai_daily_limit is null or ai_daily_limit between 0 and 10000),
  max_products integer check (max_products is null or max_products between 1 and 1000000),
  featured_slots integer not null default 0 check (featured_slots between 0 and 1000),
  is_default boolean not null default false,
  active boolean not null default true,
  position smallint not null default 0,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- O padrão é gratuito e sempre ativo; os demais cobram ao menos R$ 1,00.
  check ((is_default and price_cents = 0 and active) or (not is_default and price_cents >= 100))
);

create unique index plans_one_default_idx on public.plans (org_kind) where is_default;

insert into public.plans (org_kind, name, description, price_cents, is_default, position) values
  ('seller', 'Grátis', 'Plano inicial de toda conta de vendedor.', 0, true, 0),
  ('supplier', 'Grátis', 'Plano inicial de toda conta de fornecedor.', 0, true, 0);

create table public.organization_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  plan_id uuid not null references public.plans (id),
  -- Preço no momento da assinatura (o que o Mercado Pago cobra todo mês).
  price_cents bigint not null check (price_cents >= 100),
  status public.subscription_status not null default 'pending',
  external_id text unique check (external_id is null or external_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  checkout_url text check (checkout_url is null or (checkout_url ~ '^https://' and char_length(checkout_url) <= 500)),
  next_payment_at timestamptz,
  -- Depois de cancelada ou pausada, o plano vale até aqui.
  access_until timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  authorized_at timestamptz,
  cancelled_at timestamptz
);

-- Uma em andamento e uma vigente por empresa (troca de plano = as duas).
create unique index organization_subscriptions_pending_idx
  on public.organization_subscriptions (organization_id) where status = 'pending';
create unique index organization_subscriptions_current_idx
  on public.organization_subscriptions (organization_id) where status in ('authorized', 'paused');
create index organization_subscriptions_org_idx
  on public.organization_subscriptions (organization_id, created_at desc);
create index organization_subscriptions_plan_idx on public.organization_subscriptions (plan_id);

create table public.subscription_payments (
  id bigint generated always as identity primary key,
  subscription_id uuid not null references public.organization_subscriptions (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  external_id text not null unique check (external_id ~ '^[0-9]{1,30}$'),
  amount_cents bigint not null check (amount_cents >= 0),
  status text not null check (status in ('scheduled', 'processed', 'recycling', 'cancelled')),
  payment_status text check (payment_status is null or payment_status ~ '^[a-z_]{1,40}$'),
  debit_date timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index subscription_payments_sub_idx on public.subscription_payments (subscription_id);
create index subscription_payments_org_idx on public.subscription_payments (organization_id, created_at desc);

create table public.catalog_featured (
  listing_id uuid primary key references public.catalog_listings (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index catalog_featured_org_idx on public.catalog_featured (organization_id, created_at);

-- Sem acesso direto pela API: tudo por RPC.
revoke all on table public.plans from anon, authenticated;
revoke all on table public.organization_subscriptions from anon, authenticated;
revoke all on table public.subscription_payments from anon, authenticated;
revoke all on table public.catalog_featured from anon, authenticated;
alter table public.plans enable row level security;
alter table public.organization_subscriptions enable row level security;
alter table public.subscription_payments enable row level security;
alter table public.catalog_featured enable row level security;

-- ---------------------------------------------------------------------
-- Plano vigente e limites
-- ---------------------------------------------------------------------

/** Plano que vale agora: assinatura autorizada (ou cancelada no prazo) ou o padrão do tipo. */
create function private.org_plan(p_org uuid)
returns public.plans
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plan public.plans%rowtype;
begin
  select p.* into v_plan
  from public.organization_subscriptions s
  join public.plans p on p.id = s.plan_id
  where s.organization_id = p_org
    and (s.status = 'authorized'
         or (s.status in ('paused', 'cancelled') and s.access_until > now()))
  order by (s.status = 'authorized') desc, s.authorized_at desc nulls last
  limit 1;
  if v_plan.id is null then
    select p.* into v_plan
    from public.plans p
    join public.organizations o on o.kind = p.org_kind
    where o.id = p_org and p.is_default;
  end if;
  return v_plan;
end;
$$;

create function private.org_ai_daily_limit(p_org uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((private.org_plan(p_org)).ai_daily_limit, private.ai_daily_limit())
$$;

create or replace function private.ai_reserve(p_org uuid, p_feature text, p_product uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_used integer;
  v_usage uuid;
  v_limit integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('ai:' || p_org::text, 0));
  v_used := private.ai_used_today(p_org);
  v_limit := private.org_ai_daily_limit(p_org);
  if v_used >= v_limit then
    raise exception 'ai.quota_exceeded';
  end if;
  insert into public.ai_usage (organization_id, user_id, feature, product_id)
  values (p_org, auth.uid(), p_feature, p_product)
  returning id into v_usage;
  return jsonb_build_object('usage_id', v_usage, 'remaining', v_limit - v_used - 1);
end;
$$;

create or replace function public.ai_usage_today(p_org uuid)
returns table (used integer, daily_limit integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_org_role(p_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  return query select private.ai_used_today(p_org), private.org_ai_daily_limit(p_org);
end;
$$;

/** Limite de produtos (não arquivados) do plano. */
create function private.plan_product_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max integer;
begin
  if new.status = 'archived' or (tg_op = 'UPDATE' and old.status <> 'archived') then
    return new;
  end if;
  v_max := (private.org_plan(new.organization_id)).max_products;
  if v_max is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('products:' || new.organization_id::text, 0));
  if (select count(*) from public.products p
      where p.organization_id = new.organization_id and p.status <> 'archived'
        and p.id <> new.id) >= v_max then
    raise exception 'plans.product_limit';
  end if;
  return new;
end;
$$;

create trigger products_plan_limit
  before insert or update of status on public.products
  for each row execute function private.plan_product_limit();

/** Anúncios destacados que contam (os primeiros marcados, até as vagas do plano). */
create function private.effective_featured()
returns table (listing_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select f.listing_id from (
    select f.listing_id, f.organization_id,
           row_number() over (partition by f.organization_id order by f.created_at, f.listing_id) as rn
    from public.catalog_featured f
  ) f
  where f.rn <= (private.org_plan(f.organization_id)).featured_slots
$$;

-- ---------------------------------------------------------------------
-- Catálogo com destaque
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
    with featured as (select e.listing_id from private.effective_featured() e)
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
    order by exists (select 1 from featured f where f.listing_id = l.id) desc, l.updated_at desc, l.id
    limit least(greatest(coalesce(p_limit, 24), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

/** Fornecedor (owner/admin) marca ou desmarca um anúncio como destaque. */
create function public.set_listing_featured(p_listing uuid, p_featured boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select l.organization_id into v_org from public.catalog_listings l where l.id = p_listing;
  if v_org is null or not private.has_org_role(v_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  if p_featured is null then
    raise exception 'plans.invalid';
  end if;
  if not p_featured then
    delete from public.catalog_featured where listing_id = p_listing;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('featured:' || v_org::text, 0));
  if exists (select 1 from public.catalog_featured f where f.listing_id = p_listing) then
    return;
  end if;
  if (select count(*) from public.catalog_featured f where f.organization_id = v_org)
     >= (private.org_plan(v_org)).featured_slots then
    raise exception 'plans.featured_limit';
  end if;
  insert into public.catalog_featured (listing_id, organization_id) values (p_listing, v_org);
end;
$$;

/** Destaque de um anúncio (membros do fornecedor). */
create function public.listing_featured_status(p_listing uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select l.organization_id into v_org from public.catalog_listings l where l.id = p_listing;
  if v_org is null or not private.is_org_member(v_org) then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'marked', exists (select 1 from public.catalog_featured f where f.listing_id = p_listing),
    'active', exists (select 1 from private.effective_featured() e where e.listing_id = p_listing),
    'used', (select count(*)::integer from public.catalog_featured f where f.organization_id = v_org),
    'slots', (private.org_plan(v_org)).featured_slots
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Empresa
-- ---------------------------------------------------------------------

create function private.plan_json(p public.plans)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id, 'name', p.name, 'description', p.description, 'price_cents', p.price_cents,
    'ai_daily_limit', p.ai_daily_limit, 'max_products', p.max_products,
    'featured_slots', p.featured_slots, 'is_default', p.is_default)
$$;

/** Plano, uso dos limites, assinatura, planos disponíveis e cobranças. */
create function public.billing_overview(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind public.org_kind;
  v_plan public.plans%rowtype;
begin
  if not private.is_org_member(p_org) then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  select o.kind into v_kind from public.organizations o where o.id = p_org;
  v_plan := private.org_plan(p_org);

  return jsonb_build_object(
    'plan', private.plan_json(v_plan),
    'usage', jsonb_build_object(
      'products', (select count(*)::integer from public.products p
                   where p.organization_id = p_org and p.status <> 'archived'),
      'ai_today', private.ai_used_today(p_org),
      'ai_daily_limit', private.org_ai_daily_limit(p_org),
      'featured', (select count(*)::integer from public.catalog_featured f
                   where f.organization_id = p_org)
    ),
    'can_manage', private.has_org_role(p_org, '{owner}'),
    'current', (
      select jsonb_build_object('id', s.id, 'plan_name', p.name, 'status', s.status,
        'price_cents', s.price_cents, 'next_payment_at', s.next_payment_at,
        'access_until', s.access_until, 'authorized_at', s.authorized_at)
      from public.organization_subscriptions s join public.plans p on p.id = s.plan_id
      where s.organization_id = p_org
        and (s.status in ('authorized', 'paused')
             or (s.status = 'cancelled' and s.access_until > now()))
      order by (s.status = 'authorized') desc, s.authorized_at desc nulls last
      limit 1),
    'pending', (
      select jsonb_build_object('id', s.id, 'plan_id', s.plan_id, 'plan_name', p.name,
        'price_cents', s.price_cents, 'checkout_url', s.checkout_url, 'created_at', s.created_at)
      from public.organization_subscriptions s join public.plans p on p.id = s.plan_id
      where s.organization_id = p_org and s.status = 'pending'),
    'plans', coalesce((
      select jsonb_agg(private.plan_json(p) order by p.is_default desc, p.position, p.price_cents)
      from public.plans p where p.org_kind = v_kind and p.active), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(x order by x.created_at desc) from (
        select sp.external_id, sp.amount_cents, sp.status, sp.payment_status, sp.debit_date,
               sp.created_at
        from public.subscription_payments sp
        where sp.organization_id = p_org
        order by sp.created_at desc limit 12) x), '[]'::jsonb)
  );
end;
$$;

/**
 * Proprietário escolhe um plano pago. Cria a assinatura "em andamento"
 * (ou devolve a mesma, se já existe para o plano) com os dados para a Edge
 * Function abrir a assinatura no Mercado Pago. Uma em andamento de outro
 * plano é cancelada (`cancel_external_id`).
 */
create function public.billing_begin_subscription(p_org uuid, p_plan uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind public.org_kind;
  v_plan public.plans%rowtype;
  v_pending public.organization_subscriptions%rowtype;
  v_email text;
  v_id uuid;
begin
  if not private.has_org_role(p_org, '{owner}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  select o.kind into v_kind from public.organizations o where o.id = p_org;
  select * into v_plan from public.plans p where p.id = p_plan;
  if v_plan.id is null or not v_plan.active or v_plan.is_default or v_plan.org_kind <> v_kind then
    raise exception 'plans.unavailable';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('billing:' || p_org::text, 0));
  if exists (select 1 from public.organization_subscriptions s
             where s.organization_id = p_org and s.plan_id = p_plan and s.status = 'authorized') then
    raise exception 'plans.already_subscribed';
  end if;
  select u.email into v_email from auth.users u where u.id = auth.uid();

  select * into v_pending from public.organization_subscriptions s
  where s.organization_id = p_org and s.status = 'pending' for update;
  if v_pending.id is not null and v_pending.plan_id = p_plan
     and v_pending.checkout_url is not null and v_pending.created_at > now() - interval '1 day' then
    return jsonb_build_object('subscription_id', v_pending.id, 'checkout_url', v_pending.checkout_url);
  end if;
  if v_pending.id is not null then
    update public.organization_subscriptions
    set status = 'cancelled', cancelled_at = now(), updated_at = now()
    where id = v_pending.id;
  end if;

  insert into public.organization_subscriptions (organization_id, plan_id, price_cents, created_by)
  values (p_org, p_plan, v_plan.price_cents, auth.uid())
  returning id into v_id;

  return jsonb_build_object(
    'subscription_id', v_id,
    'checkout_url', null,
    'plan_name', v_plan.name,
    'price_cents', v_plan.price_cents,
    'payer_email', v_email,
    'cancel_external_id', v_pending.external_id
  );
end;
$$;

/** Edge Function: grava o id e o link da assinatura criada no Mercado Pago. */
create function public.billing_attach_checkout(p_subscription uuid, p_external_id text, p_checkout_url text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.organization_subscriptions
  set external_id = p_external_id, checkout_url = p_checkout_url, updated_at = now()
  where id = p_subscription and status = 'pending' and external_id is null;
  if not found then
    raise exception 'plans.not_found';
  end if;
end;
$$;

/**
 * Edge Function: aplica o estado lido na API do Mercado Pago.
 * p_data: {external_id, external_reference, status, amount_cents, next_payment_at}.
 * Devolve {action, cancel: [ids a cancelar no Mercado Pago]}.
 */
create function public.billing_sync_subscription(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.organization_subscriptions%rowtype;
  v_status public.subscription_status;
  v_next timestamptz;
  v_plan_name text;
  v_cancel text[] := '{}';
begin
  if p_data is null or coalesce(p_data ->> 'status', '') not in ('pending', 'authorized', 'paused', 'cancelled')
     or coalesce(p_data ->> 'external_id', '') !~ '^[A-Za-z0-9_-]{1,64}$'
     or coalesce(p_data ->> 'amount_cents', '') !~ '^[0-9]{1,12}$' then
    raise exception 'plans.invalid';
  end if;
  v_status := (p_data ->> 'status')::public.subscription_status;
  v_next := nullif(p_data ->> 'next_payment_at', '')::timestamptz;

  select * into v_sub from public.organization_subscriptions s
  where s.external_id = p_data ->> 'external_id' for update;
  if v_sub.id is null and coalesce(p_data ->> 'external_reference', '')
       ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into v_sub from public.organization_subscriptions s
    where s.id = (p_data ->> 'external_reference')::uuid and s.external_id is null for update;
    if v_sub.id is not null then
      update public.organization_subscriptions set external_id = p_data ->> 'external_id'
      where id = v_sub.id;
    end if;
  end if;
  if v_sub.id is null then
    return jsonb_build_object('action', 'unknown', 'cancel', '[]'::jsonb);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('billing:' || v_sub.organization_id::text, 0));
  select p.name into v_plan_name from public.plans p where p.id = v_sub.plan_id;

  -- Cancelada é final; o Mercado Pago não reativa uma assinatura cancelada.
  if v_sub.status = 'cancelled' then
    if v_status <> 'cancelled' then
      return jsonb_build_object('action', 'ignored', 'cancel', jsonb_build_array(v_sub.external_id));
    end if;
    return jsonb_build_object('action', 'ignored', 'cancel', '[]'::jsonb);
  end if;

  -- Valor diferente do combinado: não libera o plano e cancela.
  if v_status in ('authorized', 'paused') and (p_data ->> 'amount_cents')::bigint <> v_sub.price_cents then
    update public.organization_subscriptions
    set status = 'cancelled', cancelled_at = now(), access_until = null, updated_at = now()
    where id = v_sub.id;
    return jsonb_build_object('action', 'amount_mismatch',
      'cancel', jsonb_build_array(p_data ->> 'external_id'));
  end if;

  if v_status = 'authorized' and v_sub.status <> 'authorized' then
    -- Troca de plano: a vigente sai na hora (o novo plano já vale).
    with superseded as (
      update public.organization_subscriptions s
      set status = 'cancelled', cancelled_at = now(), access_until = null, updated_at = now()
      where s.organization_id = v_sub.organization_id and s.id <> v_sub.id
        and s.status in ('authorized', 'paused')
      returning s.external_id
    )
    select coalesce(array_agg(x.external_id) filter (where x.external_id is not null), '{}')
    into v_cancel from superseded x;

    update public.organization_subscriptions
    set status = 'authorized', authorized_at = coalesce(authorized_at, now()),
        next_payment_at = v_next, access_until = null, updated_at = now()
    where id = v_sub.id;
    perform private.notify_org(v_sub.organization_id, '{owner,admin}', 'billing.active',
      'Plano ' || v_plan_name || ' ativo',
      'A assinatura foi autorizada no Mercado Pago.', '/plano');
    return jsonb_build_object('action', 'authorized', 'cancel', to_jsonb(v_cancel));
  end if;

  if v_status = 'cancelled' then
    update public.organization_subscriptions
    set status = 'cancelled', cancelled_at = now(), updated_at = now(),
        access_until = case when v_sub.status = 'pending' then null
                            when v_sub.status = 'paused' then v_sub.access_until
                            else coalesce(v_sub.next_payment_at, now()) end
    where id = v_sub.id;
    if v_sub.status <> 'pending' then
      perform private.notify_org(v_sub.organization_id, '{owner,admin}', 'billing.cancelled',
        'Assinatura do plano ' || v_plan_name || ' cancelada',
        case when v_sub.next_payment_at > now()
          then 'O plano vale até ' || to_char(v_sub.next_payment_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY') || '.'
          else 'A empresa voltou para o plano gratuito.' end,
        '/plano');
    end if;
    return jsonb_build_object('action', 'cancelled', 'cancel', '[]'::jsonb);
  end if;

  if v_status = 'paused' and v_sub.status <> 'paused' then
    update public.organization_subscriptions
    set status = 'paused', access_until = coalesce(v_sub.next_payment_at, now()),
        next_payment_at = null, updated_at = now()
    where id = v_sub.id;
    return jsonb_build_object('action', 'paused', 'cancel', '[]'::jsonb);
  end if;

  update public.organization_subscriptions
  set next_payment_at = coalesce(v_next, next_payment_at), updated_at = now()
  where id = v_sub.id;
  return jsonb_build_object('action', 'unchanged', 'cancel', '[]'::jsonb);
end;
$$;

/**
 * Edge Function: registra uma cobrança da assinatura.
 * p_data: {external_id, preapproval_id, amount_cents, status, payment_status, debit_date}.
 */
create function public.billing_record_payment(p_data jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.organization_subscriptions%rowtype;
  v_previous text;
  v_payment_status text := nullif(p_data ->> 'payment_status', '');
begin
  if p_data is null or coalesce(p_data ->> 'external_id', '') !~ '^[0-9]{1,30}$'
     or coalesce(p_data ->> 'amount_cents', '') !~ '^[0-9]{1,12}$'
     or coalesce(p_data ->> 'status', '') not in ('scheduled', 'processed', 'recycling', 'cancelled') then
    raise exception 'plans.invalid';
  end if;
  select * into v_sub from public.organization_subscriptions s
  where s.external_id = p_data ->> 'preapproval_id';
  if v_sub.id is null then
    return 'unknown';
  end if;
  select sp.payment_status into v_previous from public.subscription_payments sp
  where sp.external_id = p_data ->> 'external_id';

  insert into public.subscription_payments
    (subscription_id, organization_id, external_id, amount_cents, status, payment_status, debit_date)
  values (v_sub.id, v_sub.organization_id, p_data ->> 'external_id',
    (p_data ->> 'amount_cents')::bigint, p_data ->> 'status', v_payment_status,
    nullif(p_data ->> 'debit_date', '')::timestamptz)
  on conflict (external_id) do update
  set amount_cents = excluded.amount_cents, status = excluded.status,
      payment_status = excluded.payment_status, debit_date = excluded.debit_date, updated_at = now();

  if v_payment_status = 'rejected' and v_previous is distinct from 'rejected' then
    perform private.notify_org(v_sub.organization_id, '{owner}', 'billing.payment_failed',
      'Cobrança do plano recusada',
      'O Mercado Pago vai tentar de novo. Confira o cartão da assinatura.', '/plano');
  end if;
  return 'recorded';
end;
$$;

/** Proprietário cancela: devolve o id no Mercado Pago da assinatura vigente. */
create function public.billing_cancel_begin(p_org uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_external text;
begin
  if not private.has_org_role(p_org, '{owner}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  select s.external_id into v_external from public.organization_subscriptions s
  where s.organization_id = p_org and s.status in ('authorized', 'paused') and s.external_id is not null;
  if v_external is null then
    raise exception 'plans.no_subscription';
  end if;
  return v_external;
end;
$$;

/** Assinaturas a reler no Mercado Pago (volta do pagamento, sem esperar a notificação). */
create function public.billing_refresh_targets(p_org uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_org_member(p_org) then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select array_agg(s.external_id) from public.organization_subscriptions s
    where s.organization_id = p_org and s.external_id is not null
      and s.status in ('pending', 'authorized', 'paused')), '{}');
end;
$$;

-- ---------------------------------------------------------------------
-- Equipe
-- ---------------------------------------------------------------------

create function public.admin_billing_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'plans', coalesce((
      select jsonb_agg(private.plan_json(p) || jsonb_build_object(
          'org_kind', p.org_kind, 'active', p.active, 'position', p.position,
          'subscribers', (select count(*)::integer from public.organization_subscriptions s
                          where s.plan_id = p.id and s.status = 'authorized'))
        order by p.org_kind, p.is_default desc, p.position, p.price_cents)
      from public.plans p), '[]'::jsonb),
    'monthly_revenue_cents', (select coalesce(sum(s.price_cents), 0)
      from public.organization_subscriptions s where s.status = 'authorized'),
    'subscriptions', coalesce((
      select jsonb_agg(x order by x.created_at desc) from (
        select s.id, o.name as organization_name, o.kind as org_kind, p.name as plan_name,
               s.status, s.price_cents, s.next_payment_at, s.access_until, s.created_at,
               s.authorized_at, s.cancelled_at
        from public.organization_subscriptions s
        join public.organizations o on o.id = s.organization_id
        join public.plans p on p.id = s.plan_id
        where s.status <> 'pending' or s.created_at > now() - interval '7 days'
        order by s.created_at desc limit 100) x), '[]'::jsonb)
  );
end;
$$;

/**
 * Cria (p_id nulo) ou altera um plano. Preço novo vale para novas
 * assinaturas; limites valem na hora para quem já assina. O plano
 * gratuito padrão continua gratuito e ativo.
 */
create function public.admin_save_plan(
  p_id uuid,
  p_org_kind public.org_kind,
  p_name text,
  p_description text,
  p_price_cents bigint,
  p_ai_daily_limit integer,
  p_max_products integer,
  p_featured_slots integer,
  p_active boolean,
  p_position smallint
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.plans%rowtype;
  v_id uuid;
begin
  perform private.require_platform_admin();
  if char_length(btrim(coalesce(p_name, ''))) not between 2 and 60
     or char_length(coalesce(p_description, '')) > 300
     or p_price_cents is null or p_active is null or p_featured_slots is null
     or p_featured_slots not between 0 and 1000
     or (p_ai_daily_limit is not null and p_ai_daily_limit not between 0 and 10000)
     or (p_max_products is not null and p_max_products not between 1 and 1000000) then
    raise exception 'plans.invalid';
  end if;

  if p_id is null then
    if p_org_kind is null or p_price_cents not between 100 and 100000000 then
      raise exception 'plans.invalid';
    end if;
    insert into public.plans (org_kind, name, description, price_cents, ai_daily_limit,
      max_products, featured_slots, active, position, updated_by)
    values (p_org_kind, btrim(p_name), nullif(btrim(p_description), ''), p_price_cents,
      p_ai_daily_limit, p_max_products, p_featured_slots, p_active, coalesce(p_position, 0), auth.uid())
    returning id into v_id;
  else
    select * into v_plan from public.plans p where p.id = p_id for update;
    if v_plan.id is null then
      raise exception 'plans.not_found';
    end if;
    if (v_plan.is_default and (p_price_cents <> 0 or not p_active))
       or (not v_plan.is_default and p_price_cents not between 100 and 100000000) then
      raise exception 'plans.invalid';
    end if;
    update public.plans
    set name = btrim(p_name), description = nullif(btrim(p_description), ''),
        price_cents = p_price_cents, ai_daily_limit = p_ai_daily_limit,
        max_products = p_max_products, featured_slots = p_featured_slots, active = p_active,
        position = coalesce(p_position, position), updated_by = auth.uid(), updated_at = now()
    where id = p_id;
    v_id := p_id;
  end if;

  perform private.audit('plans.saved', null, 'Plano salvo: ' || btrim(p_name),
    jsonb_build_object('plan_id', v_id, 'price_cents', p_price_cents,
      'ai_daily_limit', p_ai_daily_limit, 'max_products', p_max_products,
      'featured_slots', p_featured_slots, 'active', p_active));
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------

revoke execute on function private.org_plan(uuid) from public, anon, authenticated;
revoke execute on function private.org_ai_daily_limit(uuid) from public, anon, authenticated;
revoke execute on function private.plan_product_limit() from public, anon, authenticated;
revoke execute on function private.effective_featured() from public, anon, authenticated;
revoke execute on function private.plan_json(public.plans) from public, anon, authenticated;

revoke execute on function public.catalog_browse(text, uuid, integer, integer) from public, anon;
revoke execute on function public.set_listing_featured(uuid, boolean) from public, anon;
revoke execute on function public.listing_featured_status(uuid) from public, anon;
revoke execute on function public.billing_overview(uuid) from public, anon;
revoke execute on function public.billing_begin_subscription(uuid, uuid) from public, anon;
revoke execute on function public.billing_cancel_begin(uuid) from public, anon;
revoke execute on function public.billing_refresh_targets(uuid) from public, anon;
revoke execute on function public.admin_billing_overview() from public, anon;
revoke execute on function public.admin_save_plan(uuid, public.org_kind, text, text, bigint, integer, integer, integer, boolean, smallint) from public, anon;
grant execute on function public.catalog_browse(text, uuid, integer, integer) to authenticated;
grant execute on function public.set_listing_featured(uuid, boolean) to authenticated;
grant execute on function public.listing_featured_status(uuid) to authenticated;
grant execute on function public.billing_overview(uuid) to authenticated;
grant execute on function public.billing_begin_subscription(uuid, uuid) to authenticated;
grant execute on function public.billing_cancel_begin(uuid) to authenticated;
grant execute on function public.billing_refresh_targets(uuid) to authenticated;
grant execute on function public.admin_billing_overview() to authenticated;
grant execute on function public.admin_save_plan(uuid, public.org_kind, text, text, bigint, integer, integer, integer, boolean, smallint) to authenticated;

-- Só a Edge Function (service role).
revoke execute on function public.billing_attach_checkout(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.billing_sync_subscription(jsonb) from public, anon, authenticated;
revoke execute on function public.billing_record_payment(jsonb) from public, anon, authenticated;
grant execute on function public.billing_attach_checkout(uuid, text, text) to service_role;
grant execute on function public.billing_sync_subscription(jsonb) to service_role;
grant execute on function public.billing_record_payment(jsonb) to service_role;
