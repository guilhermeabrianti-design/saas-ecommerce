-- =====================================================================
-- Fase 35 · Catálogo aberto: publicação direta e lojas de fornecedores
--
--  * Sem fila de aprovação: fornecedor novo e anúncio novo nascem
--    aprovados e aparecem na hora para os vendedores (decisão do dono,
--    2026-10-01). A equipe continua podendo reprovar ou bloquear depois
--    pela Moderação; o que já estava "em análise" é liberado.
--  * Vitrine por fornecedor: o vendedor navega pelas lojas (apelido do
--    fornecedor, nota, quantidade de produtos e capa) e abre qualquer
--    uma para ver todos os anúncios dela. O nome real continua oculto.
-- =====================================================================

create or replace function private.organization_initial_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.approval_status := 'approved';
  new.approval_reason := null;
  new.approval_reviewed_at := null;
  return new;
end;
$$;

alter table public.catalog_listings alter column moderation_status set default 'approved';

update public.organizations set approval_status = 'approved'
where kind = 'supplier' and approval_status = 'pending';
update public.catalog_listings set moderation_status = 'approved'
where moderation_status = 'pending';

-- ---------------------------------------------------------------------
-- Vitrine
-- ---------------------------------------------------------------------

/** Anúncios visíveis, com o fornecedor (id + apelido) e filtro opcional por loja. */
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
    order by l.updated_at desc, l.id
    limit least(greatest(coalesce(p_limit, 24), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

/** Lojas de fornecedores com anúncio visível: apelido, nota, produtos e capa. */
create function public.catalog_suppliers(p_limit integer, p_offset integer)
returns table (
  supplier_id uuid,
  supplier_name text,
  listings integer,
  rating_avg numeric,
  rating_count integer,
  cover_path text,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_seller_member() then
    raise exception 'catalog.sellers_only' using errcode = '42501';
  end if;

  return query
    with visible as (
      select l.id, l.organization_id, l.product_id, l.updated_at
      from public.catalog_listings l
      join public.products p on p.id = l.product_id
      join public.organizations o on o.id = l.organization_id
      where l.is_published and p.status = 'active' and l.moderation_status = 'approved'
        and o.suspended_at is null and o.approval_status = 'approved'
    )
    select
      o.id,
      private.supplier_display_name(o.id, o.name),
      count(v.id)::integer,
      (select round(avg(r.rating), 1) from public.reviews r
        where r.target_org_id = o.id and r.hidden_at is null),
      (select count(*)::integer from public.reviews r
        where r.target_org_id = o.id and r.hidden_at is null),
      (select i.storage_path from visible v2
        join public.product_images i on i.product_id = v2.product_id
        where v2.organization_id = o.id
        order by v2.updated_at desc, i.position limit 1),
      count(*) over ()
    from visible v
    join public.organizations o on o.id = v.organization_id
    group by o.id, o.name
    order by count(v.id) desc, o.id
    limit least(greatest(coalesce(p_limit, 24), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke execute on function public.catalog_browse(text, uuid, integer, integer) from public, anon;
revoke execute on function public.catalog_suppliers(integer, integer) from public, anon;
grant execute on function public.catalog_browse(text, uuid, integer, integer) to authenticated;
grant execute on function public.catalog_suppliers(integer, integer) to authenticated;

-- Sem fila, a equipe reprova também quem já está aprovado (oculta do catálogo).
create or replace function public.admin_review_supplier(p_org uuid, p_approve boolean, p_reason text)
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
     or (not p_approve and v_org.approval_status = 'rejected') then
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
