-- =====================================================================
-- Fase 18 · Onboarding e painel do vendedor
--
--  * Perfil ganha telefone e CPF/CNPJ (só dígitos, validados aqui, com
--    dígitos verificadores). O cadastro envia os dois nos metadados; valor
--    inválido é descartado (nunca impede a criação da conta) e o checklist
--    pede para completar.
--  * Checklist do vendedor calculado de dados reais (nada é marcado à mão).
--  * Painel: vendi / lucro bruto / recebido no período e, sem período,
--    a receber dos clientes e a pagar aos fornecedores. Owner/admin.
--  * Séries por dia/semana/mês e vendas por canal (manual ou conexão).
--  * "O que vender": anúncios visíveis do catálogo ainda não importados,
--    com estoque, por margem sugerida pelo fornecedor (antes de taxas).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Validação de documentos (espelha src/utils/br.ts)
-- ---------------------------------------------------------------------
create function private.is_valid_document(p_doc text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  d integer[];
  s integer;
  r integer;
  w12 integer[] := '{5,4,3,2,9,8,7,6,5,4,3,2}';
  w13 integer[] := '{6,5,4,3,2,9,8,7,6,5,4,3,2}';
begin
  if p_doc is null or p_doc !~ '^([0-9]{11}|[0-9]{14})$' or p_doc ~ '^(.)\1+$' then
    return false;
  end if;
  d := array(select substr(p_doc, i, 1)::integer from generate_series(1, char_length(p_doc)) i);

  if array_length(d, 1) = 11 then
    for len in 9..10 loop
      s := 0;
      for i in 1..len loop
        s := s + d[i] * (len + 2 - i);
      end loop;
      r := (s * 10) % 11;
      if r = 10 then r := 0; end if;
      if r <> d[len + 1] then return false; end if;
    end loop;
    return true;
  end if;

  s := 0;
  for i in 1..12 loop s := s + d[i] * w12[i]; end loop;
  r := s % 11;
  if (case when r < 2 then 0 else 11 - r end) <> d[13] then return false; end if;
  s := 0;
  for i in 1..13 loop s := s + d[i] * w13[i]; end loop;
  r := s % 11;
  return (case when r < 2 then 0 else 11 - r end) = d[14];
end;
$$;

grant execute on function private.is_valid_document(text) to authenticated;

-- DDD (dois dígitos sem zero) + fixo (8 dígitos, começa com 2–8) ou celular (9 + 8 dígitos).
create function private.is_valid_phone(p_phone text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_phone ~ '^[1-9]{2}(9[0-9]{8}|[2-8][0-9]{7})$', false)
$$;

grant execute on function private.is_valid_phone(text) to authenticated;

-- ---------------------------------------------------------------------
-- Perfil: telefone e documento
-- ---------------------------------------------------------------------
alter table public.profiles
  add column phone text check (phone is null or private.is_valid_phone(phone)),
  add column document text check (document is null or private.is_valid_document(document));

comment on column public.profiles.phone is 'Só dígitos: DDD + número (10 ou 11).';
comment on column public.profiles.document is 'CPF (11) ou CNPJ (14), só dígitos, com dígitos verificadores válidos.';

grant update (phone, document) on table public.profiles to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requested_role text := new.raw_user_meta_data ->> 'account_type';
  v_full_name text := btrim(coalesce(new.raw_user_meta_data ->> 'full_name', ''));
  v_phone text := regexp_replace(coalesce(new.raw_user_meta_data ->> 'phone', ''), '\D', '', 'g');
  v_document text := regexp_replace(coalesce(new.raw_user_meta_data ->> 'document', ''), '\D', '', 'g');
begin
  insert into public.profiles (id, full_name, role, phone, document)
  values (
    new.id,
    case
      when char_length(v_full_name) between 2 and 120 then v_full_name
      else 'Usuário'
    end,
    case
      when v_requested_role = 'supplier' then 'supplier'::public.app_role
      else 'seller'::public.app_role
    end,
    case when private.is_valid_phone(v_phone) then v_phone end,
    case when private.is_valid_document(v_document) then v_document end
  );
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Checklist do vendedor (qualquer membro; o passo de perfil é de quem chama)
-- ---------------------------------------------------------------------
create function public.seller_onboarding(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_steps jsonb;
begin
  if v_uid is null or not private.is_org_member(p_org) or private.org_kind(p_org) <> 'seller' then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;

  v_steps := jsonb_build_array(
    jsonb_build_object('key', 'profile', 'done', exists (
      select 1 from public.profiles p
      where p.id = v_uid and p.phone is not null and p.document is not null)),
    jsonb_build_object('key', 'products', 'done', exists (
      select 1 from public.products p where p.organization_id = p_org)),
    jsonb_build_object('key', 'active_product', 'done', exists (
      select 1 from public.products p where p.organization_id = p_org and p.status = 'active')),
    jsonb_build_object('key', 'channel', 'done', exists (
      select 1 from public.integration_connections c
      where c.organization_id = p_org and c.status = 'active')),
    jsonb_build_object('key', 'first_order', 'done', exists (
      select 1 from public.orders o where o.organization_id = p_org and o.status <> 'cancelled'))
  );

  -- Só pede aula se houver curso liberado para esta conta.
  if exists (
    select 1 from public.academy_courses c
    where c.status = 'published' and private.academy_course_visible(c.id)
  ) then
    v_steps := v_steps || jsonb_build_array(jsonb_build_object('key', 'academy', 'done', exists (
      select 1 from public.academy_progress pr
      where pr.user_id = v_uid and pr.completed_at is not null)));
  end if;

  return v_steps;
end;
$$;

-- ---------------------------------------------------------------------
-- Painel do vendedor (owner/admin)
-- ---------------------------------------------------------------------
create function public.seller_dashboard(p_org uuid, p_days integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind public.org_kind := private.analytics_guard(p_org, p_days);
  v_start timestamptz := private.analytics_start(p_days);
  v_overview jsonb;
begin
  if v_kind <> 'seller' then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  v_overview := public.analytics_overview(p_org, p_days);

  return jsonb_build_object(
    'days', p_days,
    'orders', v_overview -> 'orders',
    'sold_cents', v_overview -> 'revenue_cents',
    'gross_profit_cents', v_overview -> 'gross_profit_cents',
    'units_without_cost', v_overview -> 'units_without_cost',
    'received_cents', (
      select coalesce(sum(e.amount_cents), 0) from public.ledger_entries e
      where e.organization_id = p_org and e.kind in ('sale_payment', 'refund')
        and e.created_at >= v_start),
    -- Sem período: situação atual.
    'receivable_cents', (
      select coalesce(sum(o.total_cents - (o.paid_cents - o.refunded_cents)), 0)
      from public.orders o
      where o.organization_id = p_org and o.status <> 'cancelled'
        and o.paid_cents - o.refunded_cents < o.total_cents),
    'receivable_orders', (
      select count(*) from public.orders o
      where o.organization_id = p_org and o.status <> 'cancelled'
        and o.paid_cents - o.refunded_cents < o.total_cents),
    'payable_cents', (
      select coalesce(sum(so.total_wholesale_cents), 0) from public.supplier_orders so
      where so.seller_organization_id = p_org and so.status = 'shipped' and so.paid_at is null),
    'payable_orders', (
      select count(*) from public.supplier_orders so
      where so.seller_organization_id = p_org and so.status = 'shipped' and so.paid_at is null)
  );
end;
$$;

/** Série por dia, semana (segunda a domingo) ou mês; baldes sem movimento vêm zerados. */
create function public.analytics_series(p_org uuid, p_days integer, p_bucket text)
returns table (period_start date, orders bigint, amount_cents bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind public.org_kind := private.analytics_guard(p_org, p_days);
  v_start timestamptz := private.analytics_start(p_days);
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_step interval;
begin
  if p_bucket is null or p_bucket not in ('day', 'week', 'month') then
    raise exception 'analytics.invalid_bucket';
  end if;
  v_step := ('1 ' || p_bucket)::interval;

  return query
  with sold as (
    select date_trunc(p_bucket, (t.created_at at time zone 'America/Sao_Paulo'))::date as b,
      count(*) as n, sum(t.amount) as amt
    from (
      select o.created_at, o.total_cents as amount
      from public.orders o
      where v_kind = 'seller' and o.organization_id = p_org
        and o.created_at >= v_start and o.status <> 'cancelled'
      union all
      select so.created_at, so.total_wholesale_cents
      from public.supplier_orders so
      where v_kind = 'supplier' and so.organization_id = p_org
        and so.created_at >= v_start and so.status <> 'cancelled'
    ) t
    group by 1
  )
  select g::date, coalesce(s.n, 0)::bigint, coalesce(s.amt, 0)::bigint
  from generate_series(
    date_trunc(p_bucket, (v_today - (p_days - 1))::timestamp),
    date_trunc(p_bucket, v_today::timestamp),
    v_step) g
  left join sold s on s.b = g::date
  order by 1;
end;
$$;

/** Vendas por canal: pedido manual ou provedor da conexão que trouxe o pedido. */
create function public.analytics_channels(p_org uuid, p_days integer)
returns table (channel text, orders bigint, amount_cents bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind public.org_kind := private.analytics_guard(p_org, p_days);
  v_start timestamptz := private.analytics_start(p_days);
begin
  if v_kind <> 'seller' then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;

  return query
  select coalesce(ch.provider::text, 'manual'), count(*)::bigint, sum(o.total_cents)::bigint
  from public.orders o
  left join lateral (
    select c.provider from public.external_orders e
    join public.integration_connections c on c.id = e.connection_id
    where e.order_id = o.id
    limit 1
  ) ch on true
  where o.organization_id = p_org and o.created_at >= v_start and o.status <> 'cancelled'
  group by 1
  order by 3 desc, 1;
end;
$$;

-- ---------------------------------------------------------------------
-- "O que vender" (qualquer membro do vendedor)
-- ---------------------------------------------------------------------
create function public.seller_suggestions(p_org uuid, p_limit integer)
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
      o.name,
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

grant execute on function public.seller_onboarding(uuid) to authenticated;
grant execute on function public.seller_dashboard(uuid, integer) to authenticated;
grant execute on function public.analytics_series(uuid, integer, text) to authenticated;
grant execute on function public.analytics_channels(uuid, integer) to authenticated;
grant execute on function public.seller_suggestions(uuid, integer) to authenticated;
