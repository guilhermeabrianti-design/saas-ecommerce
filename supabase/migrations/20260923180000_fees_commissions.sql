-- =====================================================================
-- Fase 15 · Taxas de marketplace, comissão do vendedor e divisão da venda
--
-- Divisão de uma venda (MVP, sem mentores):
--   venda − taxa do marketplace − valor do fornecedor − comissão do vendedor
--   = receita da plataforma (TheSigns).
--
--  * Taxas de marketplace NUNCA ficam no código: `marketplace_fee_rules`
--    por marketplace, tipo de anúncio, categoria (ou categoria-mãe), faixa
--    de preço unitário e campanha. Regra de campanha SOMA à regra base.
--  * Comissão do vendedor em `commission_rules`, precedência:
--    produto (anúncio do catálogo) > vendedor > subcategoria > categoria-mãe
--    > padrão. Comissão por campanha entra junto com as campanhas (Fase 18).
--  * O cálculo é feito só no banco (`private.compute_split`); o frontend
--    apenas exibe. Toda alteração da equipe vai para a auditoria imutável.
--  * Categorias da plataforma (dois níveis) e categoria no anúncio do
--    fornecedor.
-- =====================================================================

create type public.commission_scope as enum ('default', 'category', 'product', 'seller');

-- ---------------------------------------------------------------------
-- Categorias (mantidas pela equipe; todos os usuários leem)
-- ---------------------------------------------------------------------
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references public.categories (id) on delete restrict,
  name text not null check (name = btrim(name) and char_length(name) between 2 and 80),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (parent_id is distinct from id)
);

create unique index categories_parent_name_key on public.categories (
  coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)
);

create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

revoke all on table public.categories from anon, authenticated;
grant select on table public.categories to authenticated;
alter table public.categories enable row level security;

create policy "categories: usuários autenticados leem"
  on public.categories for select
  to authenticated
  using (true);

-- Categoria do anúncio do fornecedor (a comissão por categoria usa esta).
alter table public.catalog_listings
  add column category_id uuid references public.categories (id) on delete restrict;

create index catalog_listings_category_idx on public.catalog_listings (category_id);

grant insert (category_id), update (category_id) on table public.catalog_listings to authenticated;

create function private.catalog_listing_category_active()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.category_id is not null
     and (tg_op = 'INSERT' or new.category_id is distinct from old.category_id)
     and not exists (select 1 from public.categories c where c.id = new.category_id and c.is_active)
  then
    raise exception 'fees.category_inactive';
  end if;
  return new;
end;
$$;

create trigger catalog_listings_category_active
  before insert or update of category_id on public.catalog_listings
  for each row execute function private.catalog_listing_category_active();

-- ---------------------------------------------------------------------
-- Regras de taxa de marketplace
-- ---------------------------------------------------------------------
create table public.marketplace_fee_rules (
  id uuid primary key default gen_random_uuid(),
  provider public.marketplace_provider not null,
  -- Tipo de anúncio: ex. classico, premium, padrao, live.
  listing_type text not null check (listing_type ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  label text not null check (label = btrim(label) and char_length(label) between 2 and 60),
  category_id uuid references public.categories (id) on delete restrict,
  -- Nulo = regra base. Preenchido = acréscimo de campanha (soma à base).
  campaign text check (campaign is null or campaign ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  -- Faixa de preço unitário [mínimo, máximo) em centavos; máximo nulo = sem teto.
  min_unit_price_cents bigint not null default 0 check (min_unit_price_cents between 0 and 100000000000),
  max_unit_price_cents bigint check (
    max_unit_price_cents is null or max_unit_price_cents between 1 and 100000000000
  ),
  percent_bps integer not null check (percent_bps between 0 and 10000),
  fixed_cents_per_item bigint not null default 0 check (fixed_cents_per_item between 0 and 100000000),
  is_active boolean not null default true,
  notes text check (notes is null or char_length(notes) <= 500),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (max_unit_price_cents is null or max_unit_price_cents > min_unit_price_cents)
);

create index marketplace_fee_rules_lookup_idx
  on public.marketplace_fee_rules (provider, listing_type) where is_active;

create trigger marketplace_fee_rules_set_updated_at
  before update on public.marketplace_fee_rules
  for each row execute function public.set_updated_at();

-- Taxas de marketplace são públicas por natureza: todos leem, só a equipe
-- altera (por RPC auditada).
revoke all on table public.marketplace_fee_rules from anon, authenticated;
grant select on table public.marketplace_fee_rules to authenticated;
alter table public.marketplace_fee_rules enable row level security;

create policy "marketplace_fee_rules: usuários autenticados leem"
  on public.marketplace_fee_rules for select
  to authenticated
  using (true);

-- ---------------------------------------------------------------------
-- Regras de comissão do vendedor (sem acesso direto: acordos por vendedor
-- são privados)
-- ---------------------------------------------------------------------
create table public.commission_rules (
  id uuid primary key default gen_random_uuid(),
  scope public.commission_scope not null,
  category_id uuid references public.categories (id) on delete restrict,
  listing_id uuid references public.catalog_listings (id) on delete cascade,
  seller_org_id uuid references public.organizations (id) on delete cascade,
  percent_bps integer not null check (percent_bps between 0 and 10000),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (scope = 'default' and num_nonnulls(category_id, listing_id, seller_org_id) = 0)
    or (scope = 'category' and category_id is not null and num_nonnulls(category_id, listing_id, seller_org_id) = 1)
    or (scope = 'product' and listing_id is not null and num_nonnulls(category_id, listing_id, seller_org_id) = 1)
    or (scope = 'seller' and seller_org_id is not null and num_nonnulls(category_id, listing_id, seller_org_id) = 1)
  )
);

create unique index commission_rules_default_key on public.commission_rules (scope) where scope = 'default';
create unique index commission_rules_category_key on public.commission_rules (category_id) where category_id is not null;
create unique index commission_rules_listing_key on public.commission_rules (listing_id) where listing_id is not null;
create unique index commission_rules_seller_key on public.commission_rules (seller_org_id) where seller_org_id is not null;

create trigger commission_rules_set_updated_at
  before update on public.commission_rules
  for each row execute function public.set_updated_at();

revoke all on table public.commission_rules from anon, authenticated;
alter table public.commission_rules enable row level security;

-- Comissão padrão inicial do vendedor: 15%.
insert into public.commission_rules (scope, percent_bps) values ('default', 1500);

-- Taxas iniciais informadas pelo dono do produto em 2026-09-23. Editáveis
-- pela equipe; conferir nas tabelas oficiais de cada marketplace.
insert into public.marketplace_fee_rules
  (provider, listing_type, label, min_unit_price_cents, max_unit_price_cents, percent_bps, fixed_cents_per_item, notes)
values
  ('tiktok', 'padrao', 'Padrão', 0, 5000, 1000, 400, 'Produto abaixo de R$ 50: 10% + R$ 4 por item.'),
  ('tiktok', 'padrao', 'Padrão', 5000, null, 600, 600, 'Produto a partir de R$ 50: 6% + R$ 6 por item.'),
  ('shopee', 'live', 'Live (venda direta)', 0, null, 300, 0, 'Comissão padrão de venda direta em live. Comissão extra: cadastrar como campanha.'),
  ('mercadolivre', 'classico', 'Clássico', 0, null, 1400, 0,
   'Faixa informada: 10% a 14% conforme a categoria. Usado o teto até configurar por categoria. Custos fixos por faixa de preço: cadastrar como faixas.'),
  ('mercadolivre', 'premium', 'Premium', 0, null, 1900, 0,
   'Faixa informada: 15% a 19% conforme a categoria. Usado o teto até configurar por categoria. Custos fixos por faixa de preço: cadastrar como faixas.');

-- ---------------------------------------------------------------------
-- Resolução e cálculo (internos; sem checagem de papel — quem chama valida)
-- ---------------------------------------------------------------------

/** Regra mais específica: categoria exata > categoria-mãe > geral; depois a faixa. */
create function private.match_fee_rule(
  p_provider public.marketplace_provider,
  p_listing_type text,
  p_category uuid,
  p_campaign text,
  p_unit_cents bigint
)
returns public.marketplace_fee_rules
language sql
stable
security definer
set search_path = ''
as $$
  select r.*
  from public.marketplace_fee_rules r
  left join public.categories c on c.id = p_category
  where r.is_active
    and r.provider = p_provider
    and r.listing_type = p_listing_type
    and r.campaign is not distinct from p_campaign
    and (r.category_id is null or r.category_id = p_category or r.category_id = c.parent_id)
    and p_unit_cents >= r.min_unit_price_cents
    and (r.max_unit_price_cents is null or p_unit_cents < r.max_unit_price_cents)
  order by
    (r.category_id is not null and r.category_id = p_category) desc,
    (r.category_id is not null) desc,
    r.min_unit_price_cents desc,
    r.id
  limit 1
$$;

create function private.seller_commission(p_listing uuid, p_category uuid, p_seller uuid)
returns table (percent_bps integer, source text)
language sql
stable
security definer
set search_path = ''
as $$
  select r.percent_bps,
    case when r.scope = 'category' and r.category_id <> p_category then 'parent_category'
         else r.scope::text end
  from public.commission_rules r
  left join public.categories c on c.id = p_category
  where (r.scope = 'product' and r.listing_id = p_listing)
     or (r.scope = 'seller' and r.seller_org_id = p_seller)
     or (r.scope = 'category' and (r.category_id = p_category or r.category_id = c.parent_id))
     or r.scope = 'default'
  order by case
    when r.scope = 'product' then 1
    when r.scope = 'seller' then 2
    when r.scope = 'category' and r.category_id = p_category then 3
    when r.scope = 'category' then 4
    else 5 end
  limit 1
$$;

create function private.percent_of(p_amount bigint, p_bps integer)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select round(p_amount::numeric * p_bps / 10000)::bigint
$$;

/** Divisão da venda. Erros: fees.invalid, fees.not_configured, fees.campaign_not_configured. */
create function private.compute_split(
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
  from private.seller_commission(p_listing, p_category, p_seller) s;
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
-- RPC do vendedor: estimativa antes de publicar
-- ---------------------------------------------------------------------
create function public.estimate_sale_split(
  p_org uuid,
  p_listing uuid,
  p_provider public.marketplace_provider,
  p_listing_type text,
  p_campaign text,
  p_unit_price_cents bigint,
  p_quantity integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_listing public.catalog_listings%rowtype;
begin
  if not private.is_org_member(p_org) or private.org_kind(p_org) <> 'seller' then
    raise exception 'fees.forbidden' using errcode = '42501';
  end if;
  if not private.visible_listing(p_listing) then
    raise exception 'catalog.listing_not_found';
  end if;
  select * into v_listing from public.catalog_listings l where l.id = p_listing;

  return private.compute_split(
    p_provider, p_listing_type, p_campaign, v_listing.category_id, v_listing.id, p_org,
    p_unit_price_cents, p_quantity, v_listing.wholesale_price_cents
  );
end;
$$;

-- ---------------------------------------------------------------------
-- RPCs da equipe
-- ---------------------------------------------------------------------
create function private.audit(p_action text, p_org uuid, p_summary text, p_details jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.admin_audit_log (admin_id, action, organization_id, details)
  values (auth.uid(), p_action, p_org, coalesce(p_details, '{}'::jsonb) || jsonb_build_object('summary', p_summary))
$$;

create function public.admin_simulate_split(
  p_provider public.marketplace_provider,
  p_listing_type text,
  p_campaign text,
  p_category uuid,
  p_unit_price_cents bigint,
  p_quantity integer,
  p_supplier_unit_cents bigint,
  p_seller_org uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return private.compute_split(
    p_provider, p_listing_type, p_campaign, p_category, null, p_seller_org,
    p_unit_price_cents, p_quantity, p_supplier_unit_cents
  );
end;
$$;

/** Cria (p_id nulo) ou renomeia/move uma categoria. Só dois níveis. */
create function public.admin_save_category(p_id uuid, p_name text, p_parent uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
begin
  perform private.require_platform_admin();
  if char_length(v_name) not between 2 and 80 then
    raise exception 'fees.invalid';
  end if;
  if p_parent is not null then
    if p_parent = p_id then
      raise exception 'fees.invalid_parent';
    end if;
    if not exists (select 1 from public.categories c where c.id = p_parent and c.parent_id is null) then
      raise exception 'fees.invalid_parent';
    end if;
    if p_id is not null and exists (select 1 from public.categories c where c.parent_id = p_id) then
      raise exception 'fees.invalid_parent';
    end if;
  end if;

  if exists (
    select 1 from public.categories c
    where c.parent_id is not distinct from p_parent and lower(c.name) = lower(v_name)
      and c.id is distinct from p_id
  ) then
    raise exception 'fees.duplicate';
  end if;

  if p_id is null then
    insert into public.categories (name, parent_id) values (v_name, p_parent) returning id into v_id;
  else
    update public.categories set name = v_name, parent_id = p_parent where id = p_id returning id into v_id;
    if v_id is null then
      raise exception 'fees.not_found';
    end if;
  end if;

  perform private.audit('category.saved', null, v_name, jsonb_build_object('category_id', v_id));
  return v_id;
end;
$$;

create function public.admin_set_category_active(p_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  perform private.require_platform_admin();
  if p_active is null then
    raise exception 'fees.invalid';
  end if;
  update public.categories set is_active = p_active where id = p_id returning name into v_name;
  if v_name is null then
    raise exception 'fees.not_found';
  end if;
  perform private.audit(
    case when p_active then 'category.activated' else 'category.deactivated' end,
    null, v_name, jsonb_build_object('category_id', p_id)
  );
end;
$$;

create function private.fee_rule_overlaps(p_rule public.marketplace_fee_rules)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.marketplace_fee_rules r
    where r.is_active and r.id <> p_rule.id
      and r.provider = p_rule.provider
      and r.listing_type = p_rule.listing_type
      and r.category_id is not distinct from p_rule.category_id
      and r.campaign is not distinct from p_rule.campaign
      and r.min_unit_price_cents < coalesce(p_rule.max_unit_price_cents, 9223372036854775807)
      and p_rule.min_unit_price_cents < coalesce(r.max_unit_price_cents, 9223372036854775807)
  )
$$;

create function private.describe_fee_rule(p_rule public.marketplace_fee_rules)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p_rule.provider::text || ' · ' || p_rule.label
    || coalesce(' · campanha ' || p_rule.campaign, '')
    || coalesce(' · ' || (select c.name from public.categories c where c.id = p_rule.category_id), '')
    || ' · ' || to_char(p_rule.percent_bps / 100.0, 'FM990.00') || '%'
    || case when p_rule.fixed_cents_per_item > 0
         then ' + ' || to_char(p_rule.fixed_cents_per_item / 100.0, 'FM999999990.00') || '/item' else '' end
    || case when p_rule.is_active then '' else ' (inativa)' end
$$;

/**
 * Cria (p_id nulo) ou altera uma regra de taxa. Campos em p_rule:
 * provider, listing_type, label, category_id, campaign, min_unit_price_cents,
 * max_unit_price_cents, percent_bps, fixed_cents_per_item, is_active, notes.
 */
create function public.admin_save_fee_rule(p_id uuid, p_rule jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.marketplace_fee_rules%rowtype;
  v_new public.marketplace_fee_rules%rowtype;
begin
  perform private.require_platform_admin();
  if p_rule is null or jsonb_typeof(p_rule) <> 'object' then
    raise exception 'fees.invalid';
  end if;
  -- Serializa alterações de regras (a checagem de sobreposição depende disso).
  perform pg_advisory_xact_lock(hashtext('public.marketplace_fee_rules'));

  if p_id is not null then
    select * into v_old from public.marketplace_fee_rules r where r.id = p_id for update;
    if v_old.id is null then
      raise exception 'fees.not_found';
    end if;
  end if;

  begin
    v_new.id := coalesce(p_id, gen_random_uuid());
    v_new.provider := (p_rule ->> 'provider')::public.marketplace_provider;
    v_new.listing_type := lower(btrim(p_rule ->> 'listing_type'));
    v_new.label := btrim(p_rule ->> 'label');
    v_new.category_id := (p_rule ->> 'category_id')::uuid;
    v_new.campaign := nullif(lower(btrim(p_rule ->> 'campaign')), '');
    v_new.min_unit_price_cents := coalesce((p_rule ->> 'min_unit_price_cents')::bigint, 0);
    v_new.max_unit_price_cents := (p_rule ->> 'max_unit_price_cents')::bigint;
    v_new.percent_bps := (p_rule ->> 'percent_bps')::integer;
    v_new.fixed_cents_per_item := coalesce((p_rule ->> 'fixed_cents_per_item')::bigint, 0);
    v_new.is_active := coalesce((p_rule ->> 'is_active')::boolean, true);
    v_new.notes := nullif(btrim(p_rule ->> 'notes'), '');
  exception when others then
    raise exception 'fees.invalid';
  end;

  if v_new.provider is null or v_new.listing_type is null or v_new.label is null
     or v_new.percent_bps is null then
    raise exception 'fees.invalid';
  end if;
  if v_new.category_id is not null
     and not exists (select 1 from public.categories c where c.id = v_new.category_id) then
    raise exception 'fees.not_found';
  end if;
  if v_new.is_active and private.fee_rule_overlaps(v_new) then
    raise exception 'fees.overlap';
  end if;

  begin
    if p_id is null then
      insert into public.marketplace_fee_rules (
        id, provider, listing_type, label, category_id, campaign, min_unit_price_cents,
        max_unit_price_cents, percent_bps, fixed_cents_per_item, is_active, notes, updated_by
      ) values (
        v_new.id, v_new.provider, v_new.listing_type, v_new.label, v_new.category_id, v_new.campaign,
        v_new.min_unit_price_cents, v_new.max_unit_price_cents, v_new.percent_bps,
        v_new.fixed_cents_per_item, v_new.is_active, v_new.notes, auth.uid()
      );
    else
      update public.marketplace_fee_rules set
        provider = v_new.provider, listing_type = v_new.listing_type, label = v_new.label,
        category_id = v_new.category_id, campaign = v_new.campaign,
        min_unit_price_cents = v_new.min_unit_price_cents,
        max_unit_price_cents = v_new.max_unit_price_cents, percent_bps = v_new.percent_bps,
        fixed_cents_per_item = v_new.fixed_cents_per_item, is_active = v_new.is_active,
        notes = v_new.notes, updated_by = auth.uid()
      where id = p_id;
    end if;
  exception when check_violation or not_null_violation then
    raise exception 'fees.invalid';
  end;

  perform private.audit(
    'fees.rule_saved', null,
    case when p_id is null then '' else private.describe_fee_rule(v_old) || ' → ' end
      || private.describe_fee_rule(v_new),
    jsonb_build_object('rule_id', v_new.id,
      'before', case when p_id is null then null else to_jsonb(v_old) end,
      'after', to_jsonb(v_new))
  );
  return v_new.id;
end;
$$;

create function public.admin_set_fee_rule_active(p_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule public.marketplace_fee_rules%rowtype;
begin
  perform private.require_platform_admin();
  if p_active is null then
    raise exception 'fees.invalid';
  end if;
  perform pg_advisory_xact_lock(hashtext('public.marketplace_fee_rules'));
  select * into v_rule from public.marketplace_fee_rules r where r.id = p_id for update;
  if v_rule.id is null then
    raise exception 'fees.not_found';
  end if;
  if v_rule.is_active = p_active then
    raise exception 'fees.no_change';
  end if;
  v_rule.is_active := p_active;
  if p_active and private.fee_rule_overlaps(v_rule) then
    raise exception 'fees.overlap';
  end if;
  update public.marketplace_fee_rules set is_active = p_active, updated_by = auth.uid() where id = p_id;
  perform private.audit(
    case when p_active then 'fees.rule_activated' else 'fees.rule_deactivated' end,
    null, private.describe_fee_rule(v_rule), jsonb_build_object('rule_id', p_id)
  );
end;
$$;

create function public.admin_list_commission_rules()
returns table (
  id uuid,
  scope public.commission_scope,
  target_id uuid,
  target_name text,
  target_detail text,
  percent_bps integer,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return query
  select r.id, r.scope,
    coalesce(r.category_id, r.listing_id, r.seller_org_id),
    case r.scope
      when 'category' then (select coalesce(pc.name || ' › ', '') || c.name from public.categories c
                            left join public.categories pc on pc.id = c.parent_id where c.id = r.category_id)
      when 'product' then (select p.name from public.catalog_listings l
                           join public.products p on p.id = l.product_id where l.id = r.listing_id)
      when 'seller' then (select o.name from public.organizations o where o.id = r.seller_org_id)
      else null end,
    case r.scope
      when 'product' then (select o.name from public.catalog_listings l
                           join public.organizations o on o.id = l.organization_id where l.id = r.listing_id)
      else null end,
    r.percent_bps, r.updated_at
  from public.commission_rules r
  order by case r.scope when 'default' then 1 when 'category' then 2 when 'seller' then 3 else 4 end,
    r.created_at, r.id;
end;
$$;

create function private.describe_commission_target(p_scope public.commission_scope, p_target uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case p_scope
    when 'default' then 'padrão'
    when 'category' then 'categoria ' || (select c.name from public.categories c where c.id = p_target)
    when 'product' then 'produto ' || (select p.name from public.catalog_listings l
                                       join public.products p on p.id = l.product_id where l.id = p_target)
    when 'seller' then 'vendedor ' || (select o.name from public.organizations o where o.id = p_target)
  end
$$;

/** Define a comissão do vendedor para um alvo (cria ou substitui). */
create function public.admin_save_commission_rule(
  p_scope public.commission_scope,
  p_target uuid,
  p_percent_bps integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_old integer;
begin
  perform private.require_platform_admin();
  if p_scope is null or p_percent_bps is null or p_percent_bps not between 0 and 10000
     or (p_scope = 'default') <> (p_target is null) then
    raise exception 'fees.invalid';
  end if;
  if (p_scope = 'category' and not exists (select 1 from public.categories c where c.id = p_target))
     or (p_scope = 'product' and not exists (select 1 from public.catalog_listings l where l.id = p_target))
     or (p_scope = 'seller' and not exists (
           select 1 from public.organizations o where o.id = p_target and o.kind = 'seller')) then
    raise exception 'fees.not_found';
  end if;

  select r.id, r.percent_bps into v_id, v_old from public.commission_rules r
  where r.scope = p_scope
    and case p_scope
      when 'default' then true
      when 'category' then r.category_id = p_target
      when 'product' then r.listing_id = p_target
      else r.seller_org_id = p_target end
  for update;

  if v_id is null then
    insert into public.commission_rules (scope, category_id, listing_id, seller_org_id, percent_bps, updated_by)
    values (
      p_scope,
      case when p_scope = 'category' then p_target end,
      case when p_scope = 'product' then p_target end,
      case when p_scope = 'seller' then p_target end,
      p_percent_bps, auth.uid()
    )
    returning id into v_id;
  else
    update public.commission_rules set percent_bps = p_percent_bps, updated_by = auth.uid()
    where id = v_id;
  end if;

  perform private.audit(
    'commission.saved', case when p_scope = 'seller' then p_target end,
    'Comissão ' || private.describe_commission_target(p_scope, p_target) || ': '
      || coalesce(to_char(v_old / 100.0, 'FM990.00') || '% → ', '')
      || to_char(p_percent_bps / 100.0, 'FM990.00') || '%',
    jsonb_build_object('rule_id', v_id, 'scope', p_scope, 'target_id', p_target,
      'before_bps', v_old, 'after_bps', p_percent_bps)
  );
  return v_id;
end;
$$;

create function public.admin_delete_commission_rule(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule public.commission_rules%rowtype;
  v_target uuid;
begin
  perform private.require_platform_admin();
  select * into v_rule from public.commission_rules r where r.id = p_id for update;
  if v_rule.id is null then
    raise exception 'fees.not_found';
  end if;
  if v_rule.scope = 'default' then
    raise exception 'fees.default_required';
  end if;
  v_target := coalesce(v_rule.category_id, v_rule.listing_id, v_rule.seller_org_id);
  perform private.audit(
    'commission.deleted', v_rule.seller_org_id,
    'Comissão ' || private.describe_commission_target(v_rule.scope, v_target) || ' removida ('
      || to_char(v_rule.percent_bps / 100.0, 'FM990.00') || '%)',
    jsonb_build_object('rule_id', p_id, 'scope', v_rule.scope, 'target_id', v_target,
      'before_bps', v_rule.percent_bps)
  );
  delete from public.commission_rules where id = p_id;
end;
$$;

/** Anúncios do catálogo (qualquer status) para escolher o alvo de uma comissão por produto. */
create function public.admin_search_listings(p_search text, p_limit integer)
returns table (listing_id uuid, product_name text, supplier_name text, is_published boolean)
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
  select l.id, p.name, o.name, l.is_published
  from public.catalog_listings l
  join public.products p on p.id = l.product_id
  join public.organizations o on o.id = l.organization_id
  where v_term is null
     or position(v_term in lower(p.name)) > 0
     or position(v_term in lower(o.name)) > 0
  order by p.name, l.id
  limit greatest(least(coalesce(p_limit, 20), 50), 1);
end;
$$;

-- Auditoria: ações de taxas/comissões trazem um resumo legível.
create or replace function public.admin_audit_entries(p_limit integer, p_offset integer)
returns table (
  id uuid,
  admin_name text,
  action text,
  organization_id uuid,
  organization_name text,
  reason text,
  created_at timestamptz,
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
  select a.id, p.full_name, a.action, a.organization_id,
    coalesce(a.details ->> 'organization_name', o.name),
    coalesce(a.details ->> 'reason', a.details ->> 'summary'), a.created_at,
    count(*) over ()
  from public.admin_audit_log a
  left join public.profiles p on p.id = a.admin_id
  left join public.organizations o on o.id = a.organization_id
  order by a.created_at desc, a.id
  limit greatest(least(coalesce(p_limit, 25), 100), 1)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- Detalhe do catálogo passa a informar a categoria (create or replace mantém o grant).
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

grant execute on function public.estimate_sale_split(uuid, uuid, public.marketplace_provider, text, text, bigint, integer) to authenticated;
grant execute on function public.admin_simulate_split(public.marketplace_provider, text, text, uuid, bigint, integer, bigint, uuid) to authenticated;
grant execute on function public.admin_save_category(uuid, text, uuid) to authenticated;
grant execute on function public.admin_set_category_active(uuid, boolean) to authenticated;
grant execute on function public.admin_save_fee_rule(uuid, jsonb) to authenticated;
grant execute on function public.admin_set_fee_rule_active(uuid, boolean) to authenticated;
grant execute on function public.admin_list_commission_rules() to authenticated;
grant execute on function public.admin_save_commission_rule(public.commission_scope, uuid, integer) to authenticated;
grant execute on function public.admin_delete_commission_rule(uuid) to authenticated;
grant execute on function public.admin_search_listings(text, integer) to authenticated;
