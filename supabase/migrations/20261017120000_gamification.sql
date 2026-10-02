-- =====================================================================
-- Fase 41 · Gamificação
--
--  * Pontos só por eventos reais, gravados pelo próprio banco (gatilhos),
--    nunca pelo navegador:
--      sale_delivered            venda entregue (checkout ou marketplace; manual não conta)
--      supplier_order_shipped    fornecedor enviou um pedido de venda real
--      review_five_stars         avaliação 5 estrelas recebida
--      lesson_completed          aula da Academia concluída
--      catalog_listing_published fornecedor publicou um produto no catálogo (uma vez por anúncio)
--      ml_listing_published      vendedor publicou um anúncio no Mercado Livre (uma vez por anúncio)
--      referral_rewarded         indicação que gerou recompensa
--  * Configurável pela equipe (auditado): pontos e limite diário por evento,
--    níveis e conquistas. Mudanças valem dali em diante (o já lançado fica).
--  * Livro de pontos imutável e idempotente (organização × evento × origem).
--    Avaliação ocultada, indicação estornada ou venda cancelada depois de
--    entregue lançam o estorno dos pontos.
--  * Ranking do mês por tipo de conta. Vendedores aparecem pelo nome só se
--    o proprietário escolher; senão "Loja anônima". Fornecedores aparecem
--    sempre pelo apelido.
-- =====================================================================

create table public.gamification_rules (
  event text primary key check (event ~ '^[a-z_]{3,40}$'),
  label text not null check (char_length(label) between 2 and 80),
  org_kind public.org_kind,
  points integer not null check (points between 0 and 10000),
  -- Máximo de lançamentos por dia e organização (nulo = sem limite).
  daily_cap integer check (daily_cap is null or daily_cap between 1 and 10000),
  enabled boolean not null default true,
  position smallint not null default 0,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

insert into public.gamification_rules (event, label, org_kind, points, daily_cap, position) values
  ('sale_delivered', 'Venda entregue', 'seller', 10, 200, 1),
  ('ml_listing_published', 'Anúncio publicado no Mercado Livre', 'seller', 5, 10, 2),
  ('supplier_order_shipped', 'Pedido enviado ao cliente', 'supplier', 10, 200, 3),
  ('catalog_listing_published', 'Produto publicado no catálogo', 'supplier', 5, 10, 4),
  ('review_five_stars', 'Avaliação 5 estrelas', null, 5, 50, 5),
  ('lesson_completed', 'Aula da Academia concluída', 'seller', 3, 30, 6),
  ('referral_rewarded', 'Indicação que gerou venda', null, 50, null, 7);

create table public.gamification_levels (
  position smallint primary key check (position between 1 and 20),
  name text not null check (char_length(name) between 2 and 40),
  min_points integer not null unique check (min_points >= 0)
);

insert into public.gamification_levels (position, name, min_points) values
  (1, 'Iniciante', 0),
  (2, 'Bronze', 100),
  (3, 'Prata', 500),
  (4, 'Ouro', 2000),
  (5, 'Diamante', 10000);

create table public.gamification_achievements (
  code text primary key check (code ~ '^[a-z0-9_]{3,40}$'),
  name text not null check (char_length(name) between 2 and 60),
  description text not null check (char_length(description) between 2 and 200),
  event text not null references public.gamification_rules (event) on delete cascade,
  threshold integer not null check (threshold between 1 and 1000000),
  active boolean not null default true,
  position smallint not null default 0
);

insert into public.gamification_achievements (code, name, description, event, threshold, position) values
  ('first_sale', 'Primeira venda', 'Entregou a primeira venda.', 'sale_delivered', 1, 1),
  ('sales_10', '10 vendas', 'Entregou 10 vendas.', 'sale_delivered', 10, 2),
  ('sales_100', '100 vendas', 'Entregou 100 vendas.', 'sale_delivered', 100, 3),
  ('first_ml_listing', 'Na vitrine do Mercado Livre', 'Publicou o primeiro anúncio no Mercado Livre.', 'ml_listing_published', 1, 4),
  ('first_shipment', 'Primeiro envio', 'Enviou o primeiro pedido.', 'supplier_order_shipped', 1, 5),
  ('shipments_100', '100 envios', 'Enviou 100 pedidos.', 'supplier_order_shipped', 100, 6),
  ('catalog_10', 'Catálogo de respeito', 'Publicou 10 produtos no catálogo.', 'catalog_listing_published', 10, 7),
  ('five_stars_10', 'Bem avaliado', 'Recebeu 10 avaliações 5 estrelas.', 'review_five_stars', 10, 8),
  ('academy_10', 'Estudante dedicado', 'Concluiu 10 aulas da Academia.', 'lesson_completed', 10, 9),
  ('first_referral', 'Boa indicação', 'Uma empresa indicada fez a primeira venda.', 'referral_rewarded', 1, 10);

create table public.gamification_points (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  event text not null references public.gamification_rules (event),
  -- Origem do evento (id do pedido, da avaliação…); estorno usa 'rev:<origem>'.
  source_id text not null check (char_length(source_id) between 1 and 120),
  points integer not null check (points <> 0),
  created_at timestamptz not null default now(),
  unique (organization_id, event, source_id)
);

create index gamification_points_org_idx on public.gamification_points (organization_id, created_at desc);
create index gamification_points_month_idx on public.gamification_points (created_at, organization_id);

create table public.organization_achievements (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  code text not null references public.gamification_achievements (code) on delete cascade,
  earned_at timestamptz not null default now(),
  primary key (organization_id, code)
);

alter table public.organizations
  add column show_in_ranking boolean not null default false;

-- Imutável: pontos só entram (e saem por estorno) pelas funções abaixo.
create function private.gamification_points_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'gamification.immutable';
end;
$$;

create trigger gamification_points_no_update
  before update or delete on public.gamification_points
  for each row execute function private.gamification_points_immutable();

-- Sem acesso direto pela API: tudo por RPC.
revoke all on table public.gamification_rules from anon, authenticated;
revoke all on table public.gamification_levels from anon, authenticated;
revoke all on table public.gamification_achievements from anon, authenticated;
revoke all on table public.gamification_points from anon, authenticated;
revoke all on table public.organization_achievements from anon, authenticated;
alter table public.gamification_rules enable row level security;
alter table public.gamification_levels enable row level security;
alter table public.gamification_achievements enable row level security;
alter table public.gamification_points enable row level security;
alter table public.organization_achievements enable row level security;

-- ---------------------------------------------------------------------
-- Núcleo
-- ---------------------------------------------------------------------

create function private.gamification_total(p_org uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(coalesce(sum(g.points), 0), 0)::integer
  from public.gamification_points g where g.organization_id = p_org
$$;

/** Nível de uma pontuação: o maior cujo mínimo foi alcançado. */
create function private.gamification_level(p_points integer)
returns public.gamification_levels
language sql
stable
security definer
set search_path = ''
as $$
  select l.* from public.gamification_levels l
  where l.min_points <= p_points
  order by l.min_points desc
  limit 1
$$;

/**
 * Lança os pontos de um evento real. Ignora regra desligada, de outro tipo
 * de conta, limite diário atingido e origem já lançada. Avisa quem sobe de
 * nível e quem ganha conquista.
 */
create function private.gami_award(p_org uuid, p_event text, p_source text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule public.gamification_rules%rowtype;
  v_kind public.org_kind;
  v_before integer;
  v_inserted integer;
  v_old public.gamification_levels%rowtype;
  v_new public.gamification_levels%rowtype;
  v_ach record;
begin
  if p_org is null or p_source is null then
    return;
  end if;
  select * into v_rule from public.gamification_rules r where r.event = p_event;
  select o.kind into v_kind from public.organizations o where o.id = p_org;
  if v_rule.event is null or v_kind is null or not v_rule.enabled or v_rule.points = 0
     or (v_rule.org_kind is not null and v_rule.org_kind <> v_kind) then
    return;
  end if;
  -- Um lançamento por vez por organização (limite diário e nível consistentes).
  perform pg_advisory_xact_lock(hashtextextended('gami:' || p_org::text, 0));
  if v_rule.daily_cap is not null and (
    select count(*) from public.gamification_points g
    where g.organization_id = p_org and g.event = p_event and g.points > 0
      and g.created_at >= date_trunc('day', now())
  ) >= v_rule.daily_cap then
    return;
  end if;

  v_before := private.gamification_total(p_org);
  insert into public.gamification_points (organization_id, event, source_id, points)
  values (p_org, p_event, left(p_source, 120), v_rule.points)
  on conflict (organization_id, event, source_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return;
  end if;

  v_old := private.gamification_level(v_before);
  v_new := private.gamification_level(v_before + v_rule.points);
  if v_new.position is not null and v_new.position > coalesce(v_old.position, 0) then
    perform private.notify_org(
      p_org, '{owner,admin,member}', 'gamification.level',
      'Novo nível: ' || v_new.name,
      'Sua empresa chegou a ' || (v_before + v_rule.points) || ' pontos.',
      '/conquistas'
    );
  end if;

  for v_ach in
    insert into public.organization_achievements (organization_id, code)
    select p_org, a.code from public.gamification_achievements a
    where a.event = p_event and a.active
      and (select count(*) from public.gamification_points g
           where g.organization_id = p_org and g.event = p_event and g.points > 0) >= a.threshold
    on conflict do nothing
    returning code
  loop
    perform private.notify_org(
      p_org, '{owner,admin,member}', 'gamification.achievement',
      'Conquista: ' || (select a.name from public.gamification_achievements a where a.code = v_ach.code),
      (select a.description from public.gamification_achievements a where a.code = v_ach.code),
      '/conquistas'
    );
  end loop;
end;
$$;

/** Estorna os pontos de uma origem já lançada (uma vez). */
create function private.gami_revoke(p_org uuid, p_event text, p_source text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_points integer;
begin
  select g.points into v_points from public.gamification_points g
  where g.organization_id = p_org and g.event = p_event and g.source_id = left(p_source, 120);
  if v_points is null or v_points <= 0 then
    return;
  end if;
  insert into public.gamification_points (organization_id, event, source_id, points)
  values (p_org, p_event, left('rev:' || p_source, 120), -v_points)
  on conflict (organization_id, event, source_id) do nothing;
end;
$$;

-- ---------------------------------------------------------------------
-- Gatilhos dos eventos
-- ---------------------------------------------------------------------

create function private.gami_on_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.channel = 'manual' then
    return new;
  end if;
  if new.status = 'delivered' and old.status <> 'delivered' then
    perform private.gami_award(new.organization_id, 'sale_delivered', new.id::text);
  elsif old.status = 'delivered' and new.status = 'cancelled' then
    perform private.gami_revoke(new.organization_id, 'sale_delivered', new.id::text);
  end if;
  return new;
end;
$$;

create trigger orders_gamification
  after update of status on public.orders
  for each row when (old.status is distinct from new.status)
  execute function private.gami_on_order();

create function private.gami_on_supplier_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'shipped' and old.status <> 'shipped' and exists (
    select 1 from public.orders o where o.id = new.order_id and o.channel <> 'manual'
  ) then
    perform private.gami_award(new.organization_id, 'supplier_order_shipped', new.id::text);
  end if;
  return new;
end;
$$;

create trigger supplier_orders_gamification
  after update of status on public.supplier_orders
  for each row when (old.status is distinct from new.status)
  execute function private.gami_on_supplier_order();

create function private.gami_on_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.rating = 5 and new.hidden_at is null then
      perform private.gami_award(new.target_org_id, 'review_five_stars', new.id::text);
    end if;
  elsif new.hidden_at is not null and old.hidden_at is null then
    perform private.gami_revoke(new.target_org_id, 'review_five_stars', new.id::text);
  end if;
  return new;
end;
$$;

create trigger reviews_gamification
  after insert or update of hidden_at on public.reviews
  for each row execute function private.gami_on_review();

create function private.gami_on_lesson()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if new.completed_at is null or (tg_op = 'UPDATE' and old.completed_at is not null) then
    return new;
  end if;
  -- Uma conta = uma empresa: a primeira de que a pessoa faz parte.
  select m.organization_id into v_org from public.organization_members m
  where m.user_id = new.user_id order by m.created_at limit 1;
  perform private.gami_award(v_org, 'lesson_completed', new.user_id::text || ':' || new.lesson_id::text);
  return new;
end;
$$;

create trigger academy_progress_gamification
  after insert or update of completed_at on public.academy_progress
  for each row execute function private.gami_on_lesson();

create function private.gami_on_catalog_listing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_published and (tg_op = 'INSERT' or not old.is_published) then
    perform private.gami_award(new.organization_id, 'catalog_listing_published', new.id::text);
  end if;
  return new;
end;
$$;

create trigger catalog_listings_gamification
  after insert or update of is_published on public.catalog_listings
  for each row execute function private.gami_on_catalog_listing();

create function private.gami_on_channel_config()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.provider = 'mercadolivre' and new.external_id is not null and old.external_id is null then
    perform private.gami_award(new.organization_id, 'ml_listing_published', new.id::text);
  end if;
  return new;
end;
$$;

create trigger product_channel_configs_gamification
  after update of external_id on public.product_channel_configs
  for each row execute function private.gami_on_channel_config();

create function private.gami_on_referral()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.rewarded_at is not null and old.rewarded_at is null then
    perform private.gami_award(new.referrer_org_id, 'referral_rewarded', new.referred_org_id::text);
  elsif new.rewarded_at is null and old.rewarded_at is not null then
    perform private.gami_revoke(new.referrer_org_id, 'referral_rewarded', new.referred_org_id::text);
  end if;
  return new;
end;
$$;

create trigger organization_referrals_gamification
  after update of rewarded_at on public.organization_referrals
  for each row execute function private.gami_on_referral();

-- ---------------------------------------------------------------------
-- Empresa
-- ---------------------------------------------------------------------

/** Pontos, nível, conquistas e últimos lançamentos (membros da empresa). */
create function public.gamification_summary(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind public.org_kind;
  v_total integer;
  v_level public.gamification_levels%rowtype;
  v_next public.gamification_levels%rowtype;
begin
  if not private.is_org_member(p_org) then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  select o.kind into v_kind from public.organizations o where o.id = p_org;
  v_total := private.gamification_total(p_org);
  v_level := private.gamification_level(v_total);
  select * into v_next from public.gamification_levels l
  where l.min_points > v_total order by l.min_points limit 1;

  return jsonb_build_object(
    'total', v_total,
    'month', (select coalesce(sum(g.points), 0)::integer from public.gamification_points g
              where g.organization_id = p_org and g.created_at >= date_trunc('month', now())),
    'level', case when v_level.position is null then null
      else jsonb_build_object('name', v_level.name, 'min_points', v_level.min_points) end,
    'next_level', case when v_next.position is null then null
      else jsonb_build_object('name', v_next.name, 'min_points', v_next.min_points) end,
    'show_in_ranking', (select o.show_in_ranking from public.organizations o where o.id = p_org),
    'rules', coalesce((
      select jsonb_agg(jsonb_build_object('event', r.event, 'label', r.label, 'points', r.points,
               'daily_cap', r.daily_cap) order by r.position, r.event)
      from public.gamification_rules r
      where r.enabled and r.points > 0 and (r.org_kind is null or r.org_kind = v_kind)), '[]'::jsonb),
    'achievements', coalesce((
      select jsonb_agg(jsonb_build_object(
               'code', a.code, 'name', a.name, 'description', a.description,
               'threshold', a.threshold,
               'progress', least(a.threshold, (select count(*) from public.gamification_points g
                 where g.organization_id = p_org and g.event = a.event and g.points > 0)),
               'earned_at', oa.earned_at)
             order by a.position, a.code)
      from public.gamification_achievements a
      join public.gamification_rules r on r.event = a.event
      left join public.organization_achievements oa on oa.organization_id = p_org and oa.code = a.code
      where (a.active or oa.code is not null)
        and (r.org_kind is null or r.org_kind = v_kind)), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(x order by x.created_at desc) from (
        select g.event, r.label, g.points, g.created_at
        from public.gamification_points g
        join public.gamification_rules r on r.event = g.event
        where g.organization_id = p_org
        order by g.created_at desc, g.id desc
        limit 20
      ) x), '[]'::jsonb)
  );
end;
$$;

/**
 * Ranking do mês entre empresas do mesmo tipo: os 10 primeiros e a posição
 * da própria empresa. Nomes: o da própria; vendedor que escolheu aparecer;
 * fornecedor pelo apelido; os demais como "Loja anônima".
 */
create function public.gamification_ranking(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind public.org_kind;
begin
  if not private.is_org_member(p_org) then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  select o.kind into v_kind from public.organizations o where o.id = p_org;

  return (
    with month_points as (
      select g.organization_id, sum(g.points)::integer as points
      from public.gamification_points g
      join public.organizations o on o.id = g.organization_id
      where g.created_at >= date_trunc('month', now()) and o.kind = v_kind
        and o.suspended_at is null
      group by g.organization_id
      having sum(g.points) > 0
    ),
    ranked as (
      select m.organization_id, m.points,
             rank() over (order by m.points desc) as position
      from month_points m
    ),
    named as (
      select r.position, r.points, r.organization_id = p_org as is_me,
        case
          when r.organization_id = p_org then o.name
          when o.kind = 'supplier' then private.supplier_alias(o.id)
          when o.show_in_ranking then o.name
          else 'Loja anônima'
        end as name
      from ranked r join public.organizations o on o.id = r.organization_id
    )
    select jsonb_build_object(
      'month', to_char(date_trunc('month', now()), 'YYYY-MM'),
      'top', coalesce((select jsonb_agg(jsonb_build_object(
                'position', n.position, 'name', n.name, 'points', n.points, 'is_me', n.is_me)
              order by n.position, n.name)
              from (select * from named order by position, name limit 10) n), '[]'::jsonb),
      'me', (select jsonb_build_object('position', n.position, 'points', n.points)
             from named n where n.is_me)
    )
  );
end;
$$;

/** O proprietário do vendedor escolhe se aparece com o nome no ranking. */
create function public.set_ranking_visibility(p_org uuid, p_visible boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_org_role(p_org, '{owner}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  if p_visible is null then
    raise exception 'gamification.invalid';
  end if;
  update public.organizations set show_in_ranking = p_visible where id = p_org;
end;
$$;

-- ---------------------------------------------------------------------
-- Equipe
-- ---------------------------------------------------------------------

create function public.admin_gamification_config()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'rules', (select coalesce(jsonb_agg(jsonb_build_object(
        'event', r.event, 'label', r.label, 'org_kind', r.org_kind, 'points', r.points,
        'daily_cap', r.daily_cap, 'enabled', r.enabled) order by r.position, r.event), '[]'::jsonb)
      from public.gamification_rules r),
    'levels', (select coalesce(jsonb_agg(jsonb_build_object(
        'position', l.position, 'name', l.name, 'min_points', l.min_points)
        order by l.position), '[]'::jsonb)
      from public.gamification_levels l),
    'achievements', (select coalesce(jsonb_agg(jsonb_build_object(
        'code', a.code, 'name', a.name, 'description', a.description, 'event', a.event,
        'threshold', a.threshold, 'active', a.active) order by a.position, a.code), '[]'::jsonb)
      from public.gamification_achievements a),
    'organizations_with_points', (select count(distinct g.organization_id)::integer
      from public.gamification_points g)
  );
end;
$$;

create function public.admin_save_gamification_rule(
  p_event text,
  p_points integer,
  p_daily_cap integer,
  p_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  if p_points is null or p_points not between 0 and 10000 or p_enabled is null
     or (p_daily_cap is not null and p_daily_cap not between 1 and 10000) then
    raise exception 'gamification.invalid';
  end if;
  update public.gamification_rules
  set points = p_points, daily_cap = p_daily_cap, enabled = p_enabled,
      updated_by = auth.uid(), updated_at = now()
  where event = p_event;
  if not found then
    raise exception 'gamification.not_found';
  end if;
  perform private.audit('gamification.rule', null, 'Pontuação alterada: ' || p_event,
    jsonb_build_object('event', p_event, 'points', p_points, 'daily_cap', p_daily_cap,
      'enabled', p_enabled));
end;
$$;

/** Troca todos os níveis: [{name, min_points}], o primeiro começa em 0. */
create function public.admin_save_gamification_levels(p_levels jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform private.require_platform_admin();
  if p_levels is null or jsonb_typeof(p_levels) <> 'array' then
    raise exception 'gamification.invalid';
  end if;
  v_count := jsonb_array_length(p_levels);
  if v_count not between 1 and 20 or exists (
    select 1 from jsonb_array_elements(p_levels) e(v)
    where jsonb_typeof(e.v) <> 'object'
      or char_length(btrim(coalesce(e.v ->> 'name', ''))) not between 2 and 40
      or coalesce(e.v ->> 'min_points', '') !~ '^[0-9]{1,9}$'
  ) or (select count(distinct (e.v ->> 'min_points')::integer)
        from jsonb_array_elements(p_levels) e(v)) <> v_count
    or (select min((e.v ->> 'min_points')::integer) from jsonb_array_elements(p_levels) e(v)) <> 0
  then
    raise exception 'gamification.invalid_levels';
  end if;

  delete from public.gamification_levels;
  insert into public.gamification_levels (position, name, min_points)
  select row_number() over (order by (e.v ->> 'min_points')::integer),
         btrim(e.v ->> 'name'), (e.v ->> 'min_points')::integer
  from jsonb_array_elements(p_levels) e(v);
  perform private.audit('gamification.levels', null, 'Níveis alterados', jsonb_build_object('levels', p_levels));
end;
$$;

create function public.admin_save_achievement(
  p_code text,
  p_name text,
  p_description text,
  p_threshold integer,
  p_active boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  if char_length(btrim(coalesce(p_name, ''))) not between 2 and 60
     or char_length(btrim(coalesce(p_description, ''))) not between 2 and 200
     or p_threshold is null or p_threshold not between 1 and 1000000 or p_active is null then
    raise exception 'gamification.invalid';
  end if;
  update public.gamification_achievements
  set name = btrim(p_name), description = btrim(p_description),
      threshold = p_threshold, active = p_active
  where code = p_code;
  if not found then
    raise exception 'gamification.not_found';
  end if;
  perform private.audit('gamification.achievement', null, 'Conquista alterada: ' || p_code,
    jsonb_build_object('code', p_code, 'threshold', p_threshold, 'active', p_active));
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------

revoke execute on function private.gamification_points_immutable() from public, anon, authenticated;
revoke execute on function private.gamification_total(uuid) from public, anon, authenticated;
revoke execute on function private.gamification_level(integer) from public, anon, authenticated;
revoke execute on function private.gami_award(uuid, text, text) from public, anon, authenticated;
revoke execute on function private.gami_revoke(uuid, text, text) from public, anon, authenticated;
revoke execute on function private.gami_on_order() from public, anon, authenticated;
revoke execute on function private.gami_on_supplier_order() from public, anon, authenticated;
revoke execute on function private.gami_on_review() from public, anon, authenticated;
revoke execute on function private.gami_on_lesson() from public, anon, authenticated;
revoke execute on function private.gami_on_catalog_listing() from public, anon, authenticated;
revoke execute on function private.gami_on_channel_config() from public, anon, authenticated;
revoke execute on function private.gami_on_referral() from public, anon, authenticated;

revoke execute on function public.gamification_summary(uuid) from public, anon;
revoke execute on function public.gamification_ranking(uuid) from public, anon;
revoke execute on function public.set_ranking_visibility(uuid, boolean) from public, anon;
revoke execute on function public.admin_gamification_config() from public, anon;
revoke execute on function public.admin_save_gamification_rule(text, integer, integer, boolean) from public, anon;
revoke execute on function public.admin_save_gamification_levels(jsonb) from public, anon;
revoke execute on function public.admin_save_achievement(text, text, text, integer, boolean) from public, anon;
grant execute on function public.gamification_summary(uuid) to authenticated;
grant execute on function public.gamification_ranking(uuid) to authenticated;
grant execute on function public.set_ranking_visibility(uuid, boolean) to authenticated;
grant execute on function public.admin_gamification_config() to authenticated;
grant execute on function public.admin_save_gamification_rule(text, integer, integer, boolean) to authenticated;
grant execute on function public.admin_save_gamification_levels(jsonb) to authenticated;
grant execute on function public.admin_save_achievement(text, text, text, integer, boolean) to authenticated;
