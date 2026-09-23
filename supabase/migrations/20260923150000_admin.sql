-- =====================================================================
-- Fase 12 · Administração da plataforma
--
-- Equipe (`profiles.role = 'admin'`, definido só via SQL) ganha:
--  * visão AGREGADA da plataforma e lista de organizações (contagens,
--    nunca dados de negócio: pedidos, clientes, financeiro);
--  * suspensão/reativação de organização, sempre com motivo e registrada
--    num log de auditoria imutável.
--
-- Suspender vale em todo lugar de uma vez: `private.org_role_of` (base de
-- todas as policies e RPCs) passa a devolver nulo para organização
-- suspensa. Além disso: anúncios de fornecedor suspenso somem do catálogo
-- e a ingestão de webhooks para vendedor suspenso é recusada.
-- =====================================================================

alter table public.organizations
  add column suspended_at timestamptz,
  add column suspension_reason text check (
    suspension_reason is null or char_length(suspension_reason) between 3 and 500
  ),
  add constraint organizations_suspension_consistent check (
    (suspended_at is null) = (suspension_reason is null)
  );

create function private.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin'
  )
$$;

create function private.require_platform_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    raise exception 'admin.forbidden' using errcode = '42501';
  end if;
end;
$$;

-- Ponto único: organização suspensa não concede papel a ninguém.
create or replace function private.org_role_of(p_org uuid)
returns public.org_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.organization_members m
  join public.organizations o on o.id = m.organization_id
  where m.organization_id = p_org
    and m.user_id = (select auth.uid())
    and o.suspended_at is null
$$;

-- Fornecedor suspenso não vende: anúncios saem do catálogo e da roteirização.
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
    where l.id = p_listing and l.is_published and p.status = 'active' and o.suspended_at is null
  )
$$;

-- Vendedor suspenso não recebe pedidos de marketplace.
create or replace function public.ingest_marketplace_order(p_connection uuid, p_external_id text, p_order jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_external_id is null or char_length(p_external_id) not between 1 and 120 then
    raise exception 'integrations.invalid';
  end if;
  if exists (
    select 1 from public.integration_connections c
    join public.organizations o on o.id = c.organization_id
    where c.id = p_connection and o.suspended_at is not null
  ) then
    return 'inactive';
  end if;
  return private.ingest_order(p_connection, p_external_id, p_order);
end;
$$;

-- ---------------------------------------------------------------------
-- Log de auditoria imutável, sem acesso direto pela API
-- ---------------------------------------------------------------------
create table public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  -- Sem FKs: o registro sobrevive à exclusão de conta/organização.
  admin_id uuid not null,
  action text not null check (char_length(action) between 1 and 60),
  organization_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index admin_audit_log_created_idx on public.admin_audit_log (created_at desc);

alter table public.admin_audit_log enable row level security;
revoke all on table public.admin_audit_log from anon, authenticated;

create function private.admin_audit_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'admin.audit_immutable';
end;
$$;

create trigger admin_audit_log_no_update
  before update or delete on public.admin_audit_log
  for each row execute function private.admin_audit_immutable();

create trigger admin_audit_log_no_truncate
  before truncate on public.admin_audit_log
  for each statement execute function private.admin_audit_immutable();

-- ---------------------------------------------------------------------
-- RPCs da equipe
-- ---------------------------------------------------------------------

/** Números agregados da plataforma (sem dados de negócio individuais). */
create function public.admin_stats()
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
                           where status = 'active')
  );
end;
$$;

/** Organizações com contagens (busca por trecho do nome, sem coringas). */
create function public.admin_list_organizations(p_search text, p_limit integer, p_offset integer)
returns table (
  id uuid,
  name text,
  kind public.org_kind,
  created_at timestamptz,
  members bigint,
  orders bigint,
  suspended_at timestamptz,
  suspension_reason text,
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
  select o.id, o.name, o.kind, o.created_at,
    (select count(*) from public.organization_members m where m.organization_id = o.id),
    case when o.kind = 'seller'
      then (select count(*) from public.orders x where x.organization_id = o.id)
      else (select count(*) from public.supplier_orders x where x.organization_id = o.id) end,
    o.suspended_at, o.suspension_reason,
    count(*) over ()
  from public.organizations o
  where coalesce(btrim(p_search), '') = ''
     or position(lower(btrim(p_search)) in lower(o.name)) > 0
  order by o.created_at desc, o.id
  limit greatest(least(coalesce(p_limit, 25), 100), 1)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

/** Suspende (com motivo) ou reativa uma organização e registra na auditoria. */
create function public.admin_set_suspension(p_org uuid, p_suspended boolean, p_reason text)
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
  if p_suspended is null then
    raise exception 'admin.invalid';
  end if;

  select * into v_org from public.organizations o where o.id = p_org for update;
  if v_org.id is null then
    raise exception 'admin.not_found';
  end if;
  if (v_org.suspended_at is not null) = p_suspended then
    raise exception 'admin.no_change';
  end if;
  if p_suspended and (v_reason is null or char_length(v_reason) < 3) then
    raise exception 'admin.reason_required';
  end if;

  update public.organizations
  set suspended_at = case when p_suspended then now() end,
      suspension_reason = case when p_suspended then v_reason end
  where id = p_org;

  insert into public.admin_audit_log (admin_id, action, organization_id, details)
  values (
    auth.uid(),
    case when p_suspended then 'organization.suspended' else 'organization.reactivated' end,
    p_org,
    jsonb_build_object('organization_name', v_org.name, 'reason', v_reason)
  );
end;
$$;

create function public.admin_audit_entries(p_limit integer, p_offset integer)
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
    a.details ->> 'organization_name', a.details ->> 'reason', a.created_at,
    count(*) over ()
  from public.admin_audit_log a
  left join public.profiles p on p.id = a.admin_id
  order by a.created_at desc, a.id
  limit greatest(least(coalesce(p_limit, 25), 100), 1)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

/** Organizações suspensas das quais quem chama é membro (para explicar o bloqueio). */
create function public.my_suspended_organizations()
returns table (id uuid, name text, reason text, suspended_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.name, o.suspension_reason, o.suspended_at
  from public.organization_members m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = (select auth.uid()) and o.suspended_at is not null
  order by o.suspended_at desc
$$;

grant execute on function public.admin_stats() to authenticated;
grant execute on function public.admin_list_organizations(text, integer, integer) to authenticated;
grant execute on function public.admin_set_suspension(uuid, boolean, text) to authenticated;
grant execute on function public.admin_audit_entries(integer, integer) to authenticated;
grant execute on function public.my_suspended_organizations() to authenticated;
-- create or replace preserva as permissões já concedidas às funções redefinidas acima.
grant execute on function public.ingest_marketplace_order(uuid, text, jsonb) to service_role;

-- Catálogo e imagens: fornecedor suspenso não aparece (create or replace mantém os grants).
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
    where l.is_published and p.status = 'active' and o.suspended_at is null
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
    where l.is_published and p.status = 'active' and o.suspended_at is null
      and p_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[^/]+$'
      and p.id::text = split_part(p_name, '/', 2)
      and p.organization_id::text = split_part(p_name, '/', 1)
  )
$$;
