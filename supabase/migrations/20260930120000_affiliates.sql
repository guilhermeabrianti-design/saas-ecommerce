-- =====================================================================
-- Fase 23 · Afiliados e indicação
--
--  * Código público da organização (`public_code`): endereço da página
--    pública do vendedor (/loja/<código>) e código de indicação.
--  * Links de divulgação do vendedor (/r/<código>): apontam para um
--    produto do checkout ou para a página da loja. Cada acesso conta um
--    clique; visitas = visitantes distintos por dia (id aleatório do
--    navegador, guardado só como hash).
--  * Venda atribuída pelo checkout: o pedido guarda o link (ou a página da
--    loja) por onde o comprador chegou. Só vale link da própria loja.
--  * Indicação: uma organização informa o código de quem a indicou ao ser
--    criada (ou em até 30 dias, antes da primeira venda). Quando a indicada
--    faz a primeira venda paga pelo checkout dentro do prazo, quem indicou
--    ganha a recompensa, paga da receita da TheSigns e liberada na carteira
--    junto com o pedido que a gerou. Estorno do pedido desfaz a recompensa.
--    Valor, venda mínima e prazo são da equipe (`referral_settings`) e
--    ficam congelados na indicação. O programa nasce desligado.
-- =====================================================================

alter type public.ledger_kind add value if not exists 'referral_reward';

alter table public.ledger_entries drop constraint ledger_entries_kind_sign;
alter table public.ledger_entries add constraint ledger_entries_kind_sign check (
  (kind::text in ('sale_payment', 'supplier_receipt', 'checkout_commission', 'checkout_supplier',
    'referral_reward') and amount_cents > 0)
  or (kind::text in ('refund', 'supplier_payment', 'checkout_reversal', 'withdrawal') and amount_cents < 0)
);

alter table public.platform_ledger_entries drop constraint platform_ledger_entries_kind_check;
alter table public.platform_ledger_entries add constraint platform_ledger_entries_kind_check check (
  kind in ('checkout_revenue', 'checkout_reversal', 'referral_reward', 'referral_reversal')
);

-- Códigos públicos: 4–32 caracteres, minúsculas, dígitos e hífen no meio.
-- (Regex na própria constraint: CHECK roda com o papel de quem grava.)

/** Código aleatório de 8 caracteres sem letras ambíguas. */
create function private.new_public_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select string_agg(substr('abcdefghjkmnpqrstuvwxyz23456789', 1 + floor(random() * 31)::int, 1), '')
  from generate_series(1, 8)
$$;

create function private.normalize_public_code(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(lower(btrim(coalesce(p_code, ''))), '')
$$;

/** Códigos que colidem com rotas ou confundem o comprador. */
create function private.is_reserved_code(p_code text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_code in ('admin', 'api', 'loja', 'pedido', 'status', 'thesigns', 'suporte', 'oficial')
$$;

-- ---------------------------------------------------------------------
-- Código público da organização
-- ---------------------------------------------------------------------
alter table public.organizations
  add column public_code text unique
    check (public_code ~ '^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$' and public_code !~ '--');

create function private.set_public_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  if new.public_code is null then
    loop
      v_code := private.new_public_code();
      exit when not exists (select 1 from public.organizations o where o.public_code = v_code);
    end loop;
    new.public_code := v_code;
  end if;
  return new;
end;
$$;

create trigger organizations_set_public_code
  before insert on public.organizations
  for each row execute function private.set_public_code();

do $$
declare
  r record;
  v_code text;
begin
  for r in select id from public.organizations where public_code is null loop
    loop
      v_code := private.new_public_code();
      exit when not exists (select 1 from public.organizations o where o.public_code = v_code);
    end loop;
    update public.organizations set public_code = v_code where id = r.id;
  end loop;
end;
$$;

alter table public.organizations alter column public_code set not null;

-- ---------------------------------------------------------------------
-- Links de divulgação
-- ---------------------------------------------------------------------
create table public.affiliate_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  code text not null unique
    check (code ~ '^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$' and code !~ '--'),
  name text not null check (name = btrim(name) and char_length(name) between 2 and 80),
  -- Nulo = página da loja.
  product_id uuid references public.products (id) on delete cascade,
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index affiliate_links_org_idx on public.affiliate_links (organization_id, created_at desc);

create trigger affiliate_links_set_updated_at
  before update on public.affiliate_links
  for each row execute function public.set_updated_at();

-- Cliques e visitas: uma linha por visitante, dia e link (nulo = página da loja).
create table public.affiliate_visits (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  link_id uuid references public.affiliate_links (id) on delete cascade,
  day date not null,
  visitor_hash text not null check (visitor_hash ~ '^[0-9a-f]{64}$'),
  clicks integer not null default 1 check (clicks between 1 and 1000),
  unique nulls not distinct (organization_id, link_id, day, visitor_hash)
);

create index affiliate_visits_org_day_idx on public.affiliate_visits (organization_id, day);

-- Por onde chegou o comprador de um pedido do checkout.
create table public.order_attributions (
  order_id uuid primary key references public.orders (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  source text not null check (source in ('link', 'store')),
  link_id uuid references public.affiliate_links (id) on delete set null,
  created_at timestamptz not null default now(),
  check ((source = 'link') = (link_id is not null))
);

create index order_attributions_org_idx on public.order_attributions (organization_id, created_at);
create index order_attributions_link_idx on public.order_attributions (link_id) where link_id is not null;

-- ---------------------------------------------------------------------
-- Indicação
-- ---------------------------------------------------------------------
create table public.referral_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  reward_cents bigint not null default 0 check (reward_cents between 0 and 10000000),
  min_sale_cents bigint not null default 0 check (min_sale_cents between 0 and 100000000),
  window_days integer not null default 90 check (window_days between 1 and 365),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  check (not enabled or reward_cents > 0)
);

-- Programa desligado até a equipe definir a recompensa.
insert into public.referral_settings default values;

create table public.organization_referrals (
  referred_org_id uuid primary key references public.organizations (id) on delete cascade,
  referrer_org_id uuid not null references public.organizations (id) on delete cascade,
  -- Regra congelada no momento da indicação.
  reward_cents bigint not null check (reward_cents between 1 and 10000000),
  min_sale_cents bigint not null check (min_sale_cents >= 0),
  expires_at timestamptz not null,
  reward_order_id uuid,
  rewarded_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  check (referred_org_id <> referrer_org_id),
  check ((reward_order_id is null) = (rewarded_at is null))
);

create index organization_referrals_referrer_idx on public.organization_referrals (referrer_org_id, created_at desc);

-- ---------------------------------------------------------------------
-- Privilégios e RLS
-- ---------------------------------------------------------------------
revoke all on table public.affiliate_links from anon, authenticated;
revoke all on table public.affiliate_visits from anon, authenticated;
revoke all on table public.order_attributions from anon, authenticated;
revoke all on table public.referral_settings from anon, authenticated;
revoke all on table public.organization_referrals from anon, authenticated;

grant select on table public.affiliate_links to authenticated;
grant select on table public.order_attributions to authenticated;
grant select on table public.referral_settings to authenticated;

alter table public.affiliate_links enable row level security;
alter table public.affiliate_visits enable row level security;
alter table public.order_attributions enable row level security;
alter table public.referral_settings enable row level security;
alter table public.organization_referrals enable row level security;

create policy "affiliate_links: membros leem"
  on public.affiliate_links for select to authenticated
  using (private.is_org_member(organization_id));

create policy "order_attributions: owner/admin leem"
  on public.order_attributions for select to authenticated
  using (private.has_org_role(organization_id, '{owner,admin}'));

create policy "referral_settings: contas conectadas leem"
  on public.referral_settings for select to authenticated
  using (true);

-- ---------------------------------------------------------------------
-- Vendedor: código da loja e links
-- ---------------------------------------------------------------------

/** Troca o código público (owner). Links antigos da loja e da indicação deixam de valer. */
create function public.set_public_code(p_org uuid, p_code text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text := private.normalize_public_code(p_code);
begin
  if not private.has_org_role(p_org, '{owner}') then
    raise exception 'affiliates.forbidden' using errcode = '42501';
  end if;
  if v_code is null or v_code !~ '^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$' or v_code ~ '--' then
    raise exception 'affiliates.invalid_code';
  end if;
  if private.is_reserved_code(v_code) then
    raise exception 'affiliates.code_taken';
  end if;
  begin
    update public.organizations set public_code = v_code where id = p_org;
  exception when unique_violation then
    raise exception 'affiliates.code_taken';
  end;
  return v_code;
end;
$$;

/** Cria um link de divulgação (owner/admin do vendedor). Código vazio = gerado. */
create function public.create_affiliate_link(p_org uuid, p_name text, p_code text, p_product uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text := private.normalize_public_code(p_code);
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
begin
  if not private.has_org_role(p_org, '{owner,admin}') or private.org_kind(p_org) <> 'seller' then
    raise exception 'affiliates.forbidden' using errcode = '42501';
  end if;
  if char_length(v_name) not between 2 and 80 then
    raise exception 'affiliates.invalid_name';
  end if;
  if p_product is not null and not exists (
    select 1 from public.products p where p.id = p_product and p.organization_id = p_org
  ) then
    raise exception 'affiliates.invalid_product';
  end if;
  if (select count(*) from public.affiliate_links l where l.organization_id = p_org) >= 200 then
    raise exception 'affiliates.limit_reached';
  end if;

  if v_code is null then
    loop
      v_code := private.new_public_code();
      exit when not exists (select 1 from public.affiliate_links l where l.code = v_code);
    end loop;
  elsif v_code !~ '^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$' or v_code ~ '--' then
    raise exception 'affiliates.invalid_code';
  elsif private.is_reserved_code(v_code) then
    raise exception 'affiliates.code_taken';
  end if;

  begin
    insert into public.affiliate_links (organization_id, code, name, product_id, created_by)
    values (p_org, v_code, v_name, p_product, auth.uid())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'affiliates.code_taken';
  end;
  return v_id;
end;
$$;

/** Renomeia, pausa ou reativa um link. Código e destino não mudam (preserva as estatísticas). */
create function public.update_affiliate_link(p_link uuid, p_name text, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link public.affiliate_links%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
begin
  select * into v_link from public.affiliate_links l where l.id = p_link for update;
  if v_link.id is null or not private.has_org_role(v_link.organization_id, '{owner,admin}') then
    raise exception 'affiliates.not_found';
  end if;
  if char_length(v_name) not between 2 and 80 or p_active is null then
    raise exception 'affiliates.invalid_name';
  end if;
  update public.affiliate_links set name = v_name, is_active = p_active where id = p_link;
end;
$$;

/**
 * Desempenho por origem no período (owner/admin do vendedor): página da
 * loja, cada link e vendas sem origem registrada (acesso direto ao produto).
 * Pedidos = criados no período; pagos = aprovados e não estornados.
 */
create function public.affiliate_stats(p_org uuid, p_days integer)
returns table (
  kind text,
  link_id uuid,
  code text,
  name text,
  product_id uuid,
  product_name text,
  is_active boolean,
  clicks bigint,
  visits bigint,
  orders bigint,
  paid_orders bigint,
  sales_cents bigint,
  commission_cents bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_since date;
  v_since_ts timestamptz;
begin
  if not private.has_org_role(p_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  v_since := (now() at time zone 'America/Sao_Paulo')::date - (least(greatest(coalesce(p_days, 30), 1), 365) - 1);
  v_since_ts := v_since::timestamp at time zone 'America/Sao_Paulo';

  return query
    with sales as (
      select o.id, a.source, a.link_id,
        (c.settled_at is not null and c.reversed_at is null) as paid,
        s.sale_cents, s.seller_commission_cents
      from public.orders o
      join public.checkout_payments c on c.order_id = o.id
      join public.order_splits s on s.order_id = o.id
      left join public.order_attributions a on a.order_id = o.id
      where o.organization_id = p_org and o.channel = 'checkout' and o.created_at >= v_since_ts
        and c.external_id is not null
    ),
    visits as (
      select v.link_id, sum(v.clicks)::bigint as clicks, count(*)::bigint as visits
      from public.affiliate_visits v
      where v.organization_id = p_org and v.day >= v_since
      group by v.link_id
    ),
    agg as (
      select
        case when x.source is null then 'direct' when x.source = 'store' then 'store' else 'link' end as k,
        x.link_id as lid,
        count(*)::bigint as orders,
        count(*) filter (where x.paid)::bigint as paid_orders,
        coalesce(sum(x.sale_cents) filter (where x.paid), 0)::bigint as sales,
        coalesce(sum(x.seller_commission_cents) filter (where x.paid), 0)::bigint as commission
      from sales x
      group by 1, 2
    )
    select 'store'::text, null::uuid, org.public_code, 'Página da loja'::text, null::uuid, null::text, true,
      coalesce(vi.clicks, 0), coalesce(vi.visits, 0),
      coalesce(ag.orders, 0), coalesce(ag.paid_orders, 0), coalesce(ag.sales, 0), coalesce(ag.commission, 0)
    from public.organizations org
    left join visits vi on vi.link_id is null
    left join agg ag on ag.k = 'store'
    where org.id = p_org
    union all
    select 'link', l.id, l.code, l.name, l.product_id, p.name, l.is_active,
      coalesce(vi.clicks, 0), coalesce(vi.visits, 0),
      coalesce(ag.orders, 0), coalesce(ag.paid_orders, 0), coalesce(ag.sales, 0), coalesce(ag.commission, 0)
    from public.affiliate_links l
    left join public.products p on p.id = l.product_id
    left join visits vi on vi.link_id = l.id
    left join agg ag on ag.k = 'link' and ag.lid = l.id
    where l.organization_id = p_org
    union all
    select 'direct', null, null, 'Acesso direto ao produto', null, null, true, null::bigint, null::bigint,
      coalesce(ag.orders, 0), coalesce(ag.paid_orders, 0), coalesce(ag.sales, 0), coalesce(ag.commission, 0)
    from (select 1) one
    left join agg ag on ag.k = 'direct';
end;
$$;

-- ---------------------------------------------------------------------
-- Público (somente service role, via Edge Function `checkout`)
-- ---------------------------------------------------------------------

/** Organização vendedora ativa pelo código público. */
create function private.store_by_code(p_code text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select o.id from public.organizations o
  where o.public_code = private.normalize_public_code(p_code)
    and o.kind = 'seller' and o.suspended_at is null
$$;

/** Vitrine pública do vendedor: produtos vendáveis pelo checkout. Nulo = loja indisponível. */
create function public.store_public(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.store_by_code(p_code);
begin
  if v_org is null then
    return null;
  end if;
  return jsonb_build_object(
    'store_name', (select o.name from public.organizations o where o.id = v_org),
    'store_code', (select o.public_code from public.organizations o where o.id = v_org),
    'products', coalesce((
      select jsonb_agg(x.item order by x.name, x.id)
      from (
        select p.id, p.name, jsonb_build_object(
          'product_id', p.id,
          'name', p.name,
          -- Menor preço entre as opções vendáveis (ou o do produto simples).
          'price_cents', coalesce((
            select min(coalesce(v.price_cents, p.price_cents)) from public.product_variants v
            where v.product_id = p.id and v.is_active and v.source_variant_id is not null
          ), p.price_cents),
          'has_variants', exists (select 1 from public.product_variants v where v.product_id = p.id),
          'image_path', coalesce(
            (select i.storage_path from public.product_images i where i.product_id = p.id
             order by i.position limit 1),
            (select i.storage_path from public.product_images i
             join public.catalog_listings l on l.product_id = i.product_id
             where l.id = p.source_listing_id order by i.position limit 1))
        ) as item
        from public.products p
        where p.organization_id = v_org and p.checkout_enabled
          and private.checkout_block_reason(p.id) is null
        order by p.name, p.id
        limit 200
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

/** Destino de um link de divulgação ativo. Nulo = link inexistente, pausado ou loja indisponível. */
create function public.affiliate_link_target(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'link_code', l.code,
    'store_code', o.public_code,
    'product_id', l.product_id
  )
  from public.affiliate_links l
  join public.organizations o on o.id = l.organization_id
  where l.code = private.normalize_public_code(p_code) and l.is_active
    and o.kind = 'seller' and o.suspended_at is null
$$;

/**
 * Conta um acesso: pelo link (quando informado e ativo) ou pela página da
 * loja. Um visitante conta uma visita por dia; os cliques vão até 1000.
 */
create function public.affiliate_record_visit(p_store_code text, p_link_code text, p_visitor_hash text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_link uuid;
begin
  if p_visitor_hash is null or p_visitor_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'affiliates.invalid';
  end if;
  if p_link_code is not null then
    select l.id, l.organization_id into v_link, v_org
    from public.affiliate_links l
    join public.organizations o on o.id = l.organization_id
    where l.code = private.normalize_public_code(p_link_code) and l.is_active
      and o.kind = 'seller' and o.suspended_at is null;
  else
    v_org := private.store_by_code(p_store_code);
  end if;
  if v_org is null then
    return;
  end if;

  insert into public.affiliate_visits (organization_id, link_id, day, visitor_hash)
  values (v_org, v_link, (now() at time zone 'America/Sao_Paulo')::date, p_visitor_hash)
  on conflict (organization_id, link_id, day, visitor_hash)
  do update set clicks = least(public.affiliate_visits.clicks + 1, 1000);
end;
$$;

/**
 * Registra por onde chegou o comprador de um pedido do checkout. Só vale
 * link ativo da mesma loja do pedido (ou o código da própria loja); o resto
 * é ignorado. A primeira origem registrada vale.
 */
create function public.checkout_attribute_order(p_order uuid, p_store_code text, p_link_code text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_link uuid;
begin
  select * into v_order from public.orders o where o.id = p_order;
  if v_order.id is null or v_order.channel <> 'checkout' then
    return false;
  end if;

  if p_link_code is not null then
    select l.id into v_link from public.affiliate_links l
    where l.code = private.normalize_public_code(p_link_code) and l.is_active
      and l.organization_id = v_order.organization_id;
  end if;

  if v_link is not null then
    insert into public.order_attributions (order_id, organization_id, source, link_id)
    values (p_order, v_order.organization_id, 'link', v_link)
    on conflict (order_id) do nothing;
  elsif p_store_code is not null and exists (
    select 1 from public.organizations o
    where o.id = v_order.organization_id and o.public_code = private.normalize_public_code(p_store_code)
  ) then
    insert into public.order_attributions (order_id, organization_id, source)
    values (p_order, v_order.organization_id, 'store')
    on conflict (order_id) do nothing;
  else
    return false;
  end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------
-- Indicação: registro
-- ---------------------------------------------------------------------

/**
 * Vincula a organização `p_org` a quem a indicou (código público de outra
 * organização). O chamador valida o papel; aqui ficam as regras do programa.
 */
create function private.apply_referral(p_org uuid, p_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.referral_settings%rowtype;
  v_org public.organizations%rowtype;
  v_referrer public.organizations%rowtype;
begin
  select * into v_settings from public.referral_settings;
  if not v_settings.enabled then
    raise exception 'referral.disabled';
  end if;

  select * into v_org from public.organizations o where o.id = p_org for update;
  select * into v_referrer from public.organizations o
  where o.public_code = private.normalize_public_code(p_code);
  if v_referrer.id is null or v_referrer.suspended_at is not null or v_referrer.id = p_org then
    raise exception 'referral.invalid_code';
  end if;
  -- Autoindicação: mesmo criador ou alguém em comum nas duas organizações.
  if v_referrer.created_by = v_org.created_by or exists (
    select 1 from public.organization_members a
    join public.organization_members b on b.user_id = a.user_id
    where a.organization_id = p_org and b.organization_id = v_referrer.id
  ) then
    raise exception 'referral.self';
  end if;
  if exists (select 1 from public.organization_referrals r where r.referred_org_id = p_org) then
    raise exception 'referral.already_referred';
  end if;
  -- Só organizações novas, antes da primeira venda paga.
  if v_org.created_at < now() - interval '30 days' or exists (
    select 1 from public.ledger_entries e
    where e.organization_id = p_org and e.kind::text in ('checkout_commission', 'checkout_supplier')
  ) then
    raise exception 'referral.too_late';
  end if;

  insert into public.organization_referrals (
    referred_org_id, referrer_org_id, reward_cents, min_sale_cents, expires_at, created_by
  ) values (
    p_org, v_referrer.id, v_settings.reward_cents, v_settings.min_sale_cents,
    now() + make_interval(days => v_settings.window_days), auth.uid()
  );
end;
$$;

-- Criação de organização com código de indicação opcional (atômica: código
-- inválido não cria a organização).
drop function public.create_organization(text);

create function public.create_organization(p_name text, p_referral_code text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_account public.app_role;
  v_org uuid;
begin
  if v_uid is null then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;

  select p.role into v_account from public.profiles p where p.id = v_uid;
  if v_account is null or v_account = 'admin' then
    raise exception 'org.account_type_not_allowed' using errcode = '42501';
  end if;

  if (select count(*) from public.organizations o where o.created_by = v_uid) >= 10 then
    raise exception 'org.limit_reached';
  end if;

  insert into public.organizations (name, kind, created_by)
  values (btrim(p_name), v_account::text::public.org_kind, v_uid)
  returning id into v_org;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_org, v_uid, 'owner');

  if private.normalize_public_code(p_referral_code) is not null then
    perform private.apply_referral(v_org, p_referral_code);
  end if;

  return v_org;
end;
$$;

/** Informa quem indicou depois de criada a organização (owner). */
create function public.apply_referral_code(p_org uuid, p_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_org_role(p_org, '{owner}') then
    raise exception 'referral.forbidden' using errcode = '42501';
  end if;
  perform private.apply_referral(p_org, p_code);
end;
$$;

/** Situação da indicação da organização (owner/admin). */
create function public.referral_summary(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_settings public.referral_settings%rowtype;
  v_org public.organizations%rowtype;
begin
  if not private.has_org_role(p_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  select * into v_settings from public.referral_settings;
  select * into v_org from public.organizations o where o.id = p_org;

  return jsonb_build_object(
    'code', v_org.public_code,
    'program', jsonb_build_object(
      'enabled', v_settings.enabled,
      'reward_cents', v_settings.reward_cents,
      'min_sale_cents', v_settings.min_sale_cents,
      'window_days', v_settings.window_days
    ),
    'referred_by', (
      select jsonb_build_object(
        'name', o.name,
        'created_at', r.created_at,
        'expires_at', r.expires_at,
        'rewarded_at', r.rewarded_at
      )
      from public.organization_referrals r
      join public.organizations o on o.id = r.referrer_org_id
      where r.referred_org_id = p_org
    ),
    'can_apply', v_settings.enabled and private.has_org_role(p_org, '{owner}')
      and v_org.created_at >= now() - interval '30 days'
      and not exists (select 1 from public.organization_referrals r where r.referred_org_id = p_org)
      and not exists (
        select 1 from public.ledger_entries e
        where e.organization_id = p_org and e.kind::text in ('checkout_commission', 'checkout_supplier')
      ),
    'earned_cents', (
      select coalesce(sum(r.reward_cents), 0) from public.organization_referrals r
      where r.referrer_org_id = p_org and r.rewarded_at is not null
    ),
    'referrals', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', o.name,
        'kind', o.kind,
        'created_at', r.created_at,
        'expires_at', r.expires_at,
        'reward_cents', r.reward_cents,
        'min_sale_cents', r.min_sale_cents,
        'rewarded_at', r.rewarded_at,
        'status', case
          when r.rewarded_at is not null then 'rewarded'
          when r.expires_at < now() then 'expired'
          else 'waiting'
        end
      ) order by r.created_at desc)
      from public.organization_referrals r
      join public.organizations o on o.id = r.referred_org_id
      where r.referrer_org_id = p_org
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Indicação: recompensa (chamada na divisão do checkout)
-- ---------------------------------------------------------------------

/**
 * Primeira venda paga de uma organização indicada: credita quem indicou
 * (da receita da TheSigns). Vale para o vendedor do pedido e para cada
 * fornecedor que recebeu por ele.
 */
create function private.referral_reward(p_order uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_split public.order_splits%rowtype;
  r public.organization_referrals%rowtype;
begin
  select * into v_order from public.orders o where o.id = p_order;
  select * into v_split from public.order_splits s where s.order_id = p_order;

  for r in
    select x.* from public.organization_referrals x
    join public.organizations referrer on referrer.id = x.referrer_org_id
    where x.referred_org_id in (
        select v_order.organization_id
        union
        select so.organization_id from public.supplier_orders so where so.order_id = p_order
      )
      and x.rewarded_at is null and x.expires_at >= now()
      and v_split.sale_cents >= x.min_sale_cents
      and referrer.suspended_at is null
    order by x.referred_org_id
    for update of x
  loop
    insert into public.ledger_entries (organization_id, kind, amount_cents, order_id, description, request_id)
    values (r.referrer_org_id, 'referral_reward', r.reward_cents, p_order,
      'Recompensa de indicação — primeira venda de ' ||
        (select o.name from public.organizations o where o.id = r.referred_org_id),
      md5(p_order::text || ':referral:' || r.referred_org_id::text)::uuid);

    insert into public.platform_ledger_entries (kind, amount_cents, order_id, description, request_id)
    values ('referral_reward', -r.reward_cents, p_order,
      'Recompensa de indicação — pedido #' || v_order.number,
      md5(p_order::text || ':referral:' || r.referred_org_id::text)::uuid);

    update public.organization_referrals
    set reward_order_id = p_order, rewarded_at = now()
    where referred_org_id = r.referred_org_id;
  end loop;
end;
$$;

/**
 * Estorno do pedido que gerou recompensas: desfaz o crédito (no mesmo
 * pedido, para a carteira compensar) e a indicação volta a esperar uma
 * venda dentro do prazo.
 */
create function private.referral_reverse(p_order uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number bigint := (select o.number from public.orders o where o.id = p_order);
  r public.organization_referrals%rowtype;
begin
  for r in
    select x.* from public.organization_referrals x
    where x.reward_order_id = p_order
    order by x.referred_org_id
    for update
  loop
    insert into public.ledger_entries (organization_id, kind, amount_cents, order_id, description, request_id)
    values (r.referrer_org_id, 'checkout_reversal', -r.reward_cents, p_order,
      'Estorno da recompensa de indicação — pedido estornado',
      md5(p_order::text || ':referral-reversal:' || r.referred_org_id::text)::uuid);

    insert into public.platform_ledger_entries (kind, amount_cents, order_id, description, request_id)
    values ('referral_reversal', r.reward_cents, p_order,
      'Estorno da recompensa de indicação — pedido #' || v_number,
      md5(p_order::text || ':referral-reversal:' || r.referred_org_id::text)::uuid);

    update public.organization_referrals
    set reward_order_id = null, rewarded_at = null
    where referred_org_id = r.referred_org_id;
  end loop;
end;
$$;

-- Divisão do checkout (Fase 21) + recompensa de indicação.
create or replace function private.checkout_settle(p_payment uuid, p_fee_cents bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay public.checkout_payments%rowtype;
  v_order public.orders%rowtype;
  v_split public.order_splits%rowtype;
  v_supplier bigint;
  v_platform bigint;
  so record;
begin
  select * into v_pay from public.checkout_payments c where c.id = p_payment;
  select * into v_order from public.orders o where o.id = v_pay.order_id;
  select * into v_split from public.order_splits s where s.order_id = v_pay.order_id for update;

  -- Atacado efetivo = o dos pedidos de fornecimento criados na confirmação.
  select coalesce(sum(x.total_wholesale_cents), 0) into v_supplier
  from public.supplier_orders x where x.order_id = v_order.id;
  v_platform := v_pay.amount_cents - p_fee_cents - v_supplier - v_split.seller_commission_cents;

  insert into public.order_payments (
    organization_id, order_id, kind, method, amount_cents, note, request_id
  ) values (
    v_order.organization_id, v_order.id, 'payment', v_pay.method, v_pay.amount_cents,
    'Checkout · Mercado Pago ' || v_pay.external_id, v_pay.id
  );
  update public.orders set paid_cents = paid_cents + v_pay.amount_cents where id = v_order.id;

  if v_split.seller_commission_cents > 0 then
    insert into public.ledger_entries (organization_id, kind, amount_cents, order_id, description, request_id)
    values (v_order.organization_id, 'checkout_commission', v_split.seller_commission_cents, v_order.id,
      'Comissão do checkout — pedido #' || v_order.number, v_pay.id);
  end if;

  for so in select * from public.supplier_orders x where x.order_id = v_order.id order by x.id loop
    if so.total_wholesale_cents > 0 then
      insert into public.ledger_entries (
        organization_id, kind, amount_cents, order_id, supplier_order_id, description, request_id
      ) values (
        so.organization_id, 'checkout_supplier', so.total_wholesale_cents, v_order.id, so.id,
        'Venda pelo checkout — fornecimento #' || so.number, so.id
      );
    end if;
  end loop;
  -- A plataforma acerta com o fornecedor: nada a pagar pelo vendedor.
  update public.supplier_orders set paid_at = now() where order_id = v_order.id;

  if v_platform <> 0 then
    insert into public.platform_ledger_entries (kind, amount_cents, order_id, checkout_payment_id, description, request_id)
    values ('checkout_revenue', v_platform, v_order.id, v_pay.id,
      'Receita do checkout — pedido #' || v_order.number, v_pay.id);
  end if;

  update public.order_splits
  set payment_fee_cents = p_fee_cents, supplier_cents = v_supplier, platform_cents = v_platform,
      settled_at = now()
  where order_id = v_order.id;
  update public.checkout_payments set settled_at = now() where id = v_pay.id;

  perform private.referral_reward(v_order.id);
end;
$$;

create or replace function private.checkout_reverse(p_payment uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay public.checkout_payments%rowtype;
  v_order public.orders%rowtype;
  v_split public.order_splits%rowtype;
  v_kept bigint := 0;
  v_platform bigint;
  so record;
begin
  select * into v_pay from public.checkout_payments c where c.id = p_payment;
  select * into v_order from public.orders o where o.id = v_pay.order_id;
  select * into v_split from public.order_splits s where s.order_id = v_pay.order_id;

  insert into public.order_payments (
    organization_id, order_id, kind, method, amount_cents, note, request_id
  ) values (
    v_order.organization_id, v_order.id, 'refund', v_pay.method, v_pay.amount_cents,
    'Checkout · estorno Mercado Pago ' || v_pay.external_id,
    md5(v_pay.id::text || ':reversal')::uuid
  );
  update public.orders set refunded_cents = refunded_cents + v_pay.amount_cents where id = v_order.id;

  if v_split.seller_commission_cents > 0 then
    insert into public.ledger_entries (organization_id, kind, amount_cents, order_id, description, request_id)
    values (v_order.organization_id, 'checkout_reversal', -v_split.seller_commission_cents, v_order.id,
      'Estorno do checkout — pedido #' || v_order.number, md5(v_pay.id::text || ':reversal')::uuid);
  end if;

  for so in select * from public.supplier_orders x where x.order_id = v_order.id order by x.id loop
    if so.total_wholesale_cents = 0 then
      continue;
    end if;
    if so.status = 'shipped' then
      v_kept := v_kept + so.total_wholesale_cents;
    else
      insert into public.ledger_entries (
        organization_id, kind, amount_cents, order_id, supplier_order_id, description, request_id
      ) values (
        so.organization_id, 'checkout_reversal', -so.total_wholesale_cents, v_order.id, so.id,
        'Estorno do checkout — fornecimento #' || so.number, md5(so.id::text || ':reversal')::uuid
      );
    end if;
  end loop;

  v_platform := -(v_split.platform_cents + v_kept);
  if v_platform <> 0 then
    insert into public.platform_ledger_entries (kind, amount_cents, order_id, checkout_payment_id, description, request_id)
    values ('checkout_reversal', v_platform, v_order.id, v_pay.id,
      'Estorno do checkout — pedido #' || v_order.number, md5(v_pay.id::text || ':reversal')::uuid);
  end if;

  update public.checkout_payments set reversed_at = now() where id = v_pay.id;

  perform private.referral_reverse(v_order.id);
end;
$$;

-- ---------------------------------------------------------------------
-- Carteira (Fase 22): recompensas de indicação entram como crédito do
-- pedido que as gerou e liberam junto com ele.
-- ---------------------------------------------------------------------
create or replace function private.wallet_balance(p_org uuid)
returns table (
  available_cents bigint,
  pending_cents bigint,
  blocked_cents bigint,
  withdrawn_cents bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with by_order as (
    select e.order_id, sum(e.amount_cents) as amount, private.order_release_at(e.order_id) as release_at
    from public.ledger_entries e
    where e.organization_id = p_org
      and e.kind::text in ('checkout_commission', 'checkout_supplier', 'checkout_reversal', 'referral_reward')
    group by e.order_id
  ),
  totals as (
    select
      coalesce(sum(b.amount) filter (where b.release_at <= now()), 0) as released,
      coalesce(sum(b.amount) filter (where b.release_at is null or b.release_at > now()), 0) as pending
    from by_order b
  ),
  withdrawn as (
    select coalesce(-sum(e.amount_cents), 0) as amount
    from public.ledger_entries e
    where e.organization_id = p_org and e.kind::text = 'withdrawal'
  ),
  blocked as (
    select coalesce(sum(w.amount_cents), 0) as amount
    from public.withdrawal_requests w
    where w.organization_id = p_org and w.status in ('requested', 'approved')
  )
  select
    (t.released - wd.amount - bl.amount)::bigint,
    t.pending::bigint,
    bl.amount::bigint,
    wd.amount::bigint
  from totals t, withdrawn wd, blocked bl
$$;

create or replace function public.wallet_pending(p_org uuid)
returns table (
  order_id uuid,
  description text,
  amount_cents bigint,
  release_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_org_role(p_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  return query
    select x.order_id, x.description, x.amount, x.release_at, x.created_at
    from (
      select e.order_id,
        (array_agg(e.description order by e.created_at))[1] as description,
        sum(e.amount_cents)::bigint as amount,
        private.order_release_at(e.order_id) as release_at,
        min(e.created_at) as created_at
      from public.ledger_entries e
      where e.organization_id = p_org
        and e.kind::text in ('checkout_commission', 'checkout_supplier', 'checkout_reversal', 'referral_reward')
      group by e.order_id
    ) x
    where x.amount <> 0 and (x.release_at is null or x.release_at > now())
    order by x.release_at nulls last, x.created_at
    limit 200;
end;
$$;

-- ---------------------------------------------------------------------
-- Equipe
-- ---------------------------------------------------------------------

create function public.admin_save_referral_settings(
  p_enabled boolean,
  p_reward_cents bigint,
  p_min_sale_cents bigint,
  p_window_days integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  if p_enabled is null or p_reward_cents is null or p_min_sale_cents is null or p_window_days is null
     or (p_enabled and p_reward_cents < 1) then
    raise exception 'referral.invalid_settings';
  end if;
  update public.referral_settings set
    enabled = p_enabled,
    reward_cents = p_reward_cents,
    min_sale_cents = p_min_sale_cents,
    window_days = p_window_days,
    updated_by = auth.uid(),
    updated_at = now();
  perform private.audit(
    'referral.settings', null, 'Regras de indicação alteradas',
    jsonb_build_object(
      'enabled', p_enabled, 'reward_cents', p_reward_cents,
      'min_sale_cents', p_min_sale_cents, 'window_days', p_window_days
    )
  );
end;
$$;

create function public.admin_referrals_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'total', (select count(*) from public.organization_referrals),
    'waiting', (select count(*) from public.organization_referrals r
                where r.rewarded_at is null and r.expires_at >= now()),
    'rewarded', (select count(*) from public.organization_referrals r where r.rewarded_at is not null),
    'rewarded_cents', (select coalesce(sum(r.reward_cents), 0) from public.organization_referrals r
                       where r.rewarded_at is not null)
  );
end;
$$;

/** Indicações, mais recentes primeiro. */
create function public.admin_referrals(p_limit integer, p_offset integer)
returns table (
  referred_org_id uuid,
  referred_name text,
  referred_kind public.org_kind,
  referrer_org_id uuid,
  referrer_name text,
  reward_cents bigint,
  min_sale_cents bigint,
  status text,
  created_at timestamptz,
  expires_at timestamptz,
  rewarded_at timestamptz,
  reward_order_number bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return query
    select r.referred_org_id, referred.name, referred.kind, r.referrer_org_id, referrer.name,
      r.reward_cents, r.min_sale_cents,
      case
        when r.rewarded_at is not null then 'rewarded'
        when r.expires_at < now() then 'expired'
        else 'waiting'
      end,
      r.created_at, r.expires_at, r.rewarded_at,
      (select o.number from public.orders o where o.id = r.reward_order_id)
    from public.organization_referrals r
    join public.organizations referred on referred.id = r.referred_org_id
    join public.organizations referrer on referrer.id = r.referrer_org_id
    order by r.created_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function private.new_public_code() from public, anon, authenticated;
revoke execute on function private.normalize_public_code(text) from public, anon, authenticated;
revoke execute on function private.is_reserved_code(text) from public, anon, authenticated;
revoke execute on function private.set_public_code() from public, anon, authenticated;
revoke execute on function private.store_by_code(text) from public, anon, authenticated;
revoke execute on function private.apply_referral(uuid, text) from public, anon, authenticated;
revoke execute on function private.referral_reward(uuid) from public, anon, authenticated;
revoke execute on function private.referral_reverse(uuid) from public, anon, authenticated;

revoke execute on function public.create_organization(text, text) from public, anon;
grant execute on function public.create_organization(text, text) to authenticated;
grant execute on function public.set_public_code(uuid, text) to authenticated;
grant execute on function public.create_affiliate_link(uuid, text, text, uuid) to authenticated;
grant execute on function public.update_affiliate_link(uuid, text, boolean) to authenticated;
grant execute on function public.affiliate_stats(uuid, integer) to authenticated;
grant execute on function public.apply_referral_code(uuid, text) to authenticated;
grant execute on function public.referral_summary(uuid) to authenticated;
grant execute on function public.admin_save_referral_settings(boolean, bigint, bigint, integer) to authenticated;
grant execute on function public.admin_referrals_overview() to authenticated;
grant execute on function public.admin_referrals(integer, integer) to authenticated;

grant execute on function public.store_public(text) to service_role;
grant execute on function public.affiliate_link_target(text) to service_role;
grant execute on function public.affiliate_record_visit(text, text, text) to service_role;
grant execute on function public.checkout_attribute_order(uuid, text, text) to service_role;
