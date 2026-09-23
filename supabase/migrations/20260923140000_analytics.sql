-- =====================================================================
-- Fase 11 · Analytics
--
-- Leitura agregada por RPC (sem tabelas novas), só owner/admin da
-- organização. Vendedor: vendas; fornecedor: fornecimentos. Dias e janelas
-- no fuso de São Paulo. Pedidos cancelados não entram em receita/unidades.
-- Custo do produto próprio é o custo ATUAL do cadastro (não há snapshot);
-- o custo de dropshipping é o atacado congelado no pedido de fornecimento.
-- =====================================================================

/** Primeiro instante da janela de p_days dias (inclui o dia de hoje). */
create function private.analytics_start(p_days integer)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select (((now() at time zone 'America/Sao_Paulo')::date - (p_days - 1))::timestamp)
         at time zone 'America/Sao_Paulo'
$$;

create function private.analytics_guard(p_org uuid, p_days integer)
returns public.org_kind
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_org_role(p_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  if p_days is null or p_days not between 1 and 366 then
    raise exception 'analytics.invalid_period';
  end if;
  return private.org_kind(p_org);
end;
$$;

/** Indicadores do período (jsonb: as chaves dependem do tipo da organização). */
create function public.analytics_overview(p_org uuid, p_days integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind public.org_kind := private.analytics_guard(p_org, p_days);
  v_start timestamptz := private.analytics_start(p_days);
  v_result jsonb;
begin
  if v_kind = 'seller' then
    select jsonb_build_object(
      'orders', count(*) filter (where o.status <> 'cancelled'),
      'cancelled', count(*) filter (where o.status = 'cancelled'),
      'revenue_cents', coalesce(sum(o.total_cents) filter (where o.status <> 'cancelled'), 0),
      'goods_revenue_cents',
        coalesce(sum(o.subtotal_cents - o.discount_cents) filter (where o.status <> 'cancelled'), 0),
      'marketplace_orders', count(*) filter (
        where o.status <> 'cancelled'
          and exists (select 1 from public.external_orders e where e.order_id = o.id)),
      'pending', count(*) filter (where o.status = 'pending'),
      'confirmed', count(*) filter (where o.status = 'confirmed'),
      'shipped', count(*) filter (where o.status = 'shipped'),
      'delivered', count(*) filter (where o.status = 'delivered')
    ) into v_result
    from public.orders o
    where o.organization_id = p_org and o.created_at >= v_start;

    v_result := v_result || (
      select jsonb_build_object(
        'units', coalesce(sum(oi.quantity), 0),
        -- Dropshipping: atacado congelado; estoque próprio: custo atual do cadastro.
        'goods_cost_cents', coalesce(sum(
          case when oi.fulfillment = 'supplier' then soi.unit_wholesale_cents * oi.quantity
               else coalesce(p.cost_cents, 0) * oi.quantity end), 0),
        'units_without_cost', coalesce(sum(oi.quantity) filter (
          where oi.fulfillment = 'own_stock' and p.cost_cents is null), 0)
      )
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      join public.products p on p.id = oi.product_id
      left join public.supplier_order_items soi on soi.order_item_id = oi.id
      where o.organization_id = p_org and o.created_at >= v_start and o.status <> 'cancelled'
    );
    v_result := v_result || jsonb_build_object(
      'avg_ticket_cents',
      case when (v_result ->> 'orders')::bigint = 0 then 0
           else round((v_result ->> 'revenue_cents')::numeric / (v_result ->> 'orders')::bigint) end,
      'gross_profit_cents',
      (v_result ->> 'goods_revenue_cents')::bigint - (v_result ->> 'goods_cost_cents')::bigint,
      'low_stock_items', (
        select count(*) from public.inventory_levels l
        where l.organization_id = p_org and l.is_low)
    );
  else
    select jsonb_build_object(
      'orders', count(*) filter (where so.status <> 'cancelled'),
      'cancelled', count(*) filter (where so.status = 'cancelled'),
      'wholesale_cents', coalesce(sum(so.total_wholesale_cents) filter (where so.status <> 'cancelled'), 0),
      'awaiting_shipment', count(*) filter (where so.status = 'pending'),
      'shipped', count(*) filter (where so.status = 'shipped'),
      'unpaid_cents', coalesce(sum(so.total_wholesale_cents) filter (
        where so.status = 'shipped' and so.paid_at is null), 0)
    ) into v_result
    from public.supplier_orders so
    where so.organization_id = p_org and so.created_at >= v_start;

    v_result := v_result || (
      select jsonb_build_object('units', coalesce(sum(soi.quantity), 0))
      from public.supplier_order_items soi
      join public.supplier_orders so on so.id = soi.supplier_order_id
      where so.organization_id = p_org and so.created_at >= v_start and so.status <> 'cancelled'
    );
    v_result := v_result || jsonb_build_object(
      'avg_ticket_cents',
      case when (v_result ->> 'orders')::bigint = 0 then 0
           else round((v_result ->> 'wholesale_cents')::numeric / (v_result ->> 'orders')::bigint) end,
      'low_stock_items', (
        select count(*) from public.inventory_levels l
        where l.organization_id = p_org and l.is_low)
    );
  end if;

  return v_result || jsonb_build_object('kind', v_kind, 'days', p_days);
end;
$$;

/** Série diária (todos os dias da janela, inclusive sem pedidos). */
create function public.analytics_daily(p_org uuid, p_days integer)
returns table (day date, orders bigint, amount_cents bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind public.org_kind := private.analytics_guard(p_org, p_days);
  v_start timestamptz := private.analytics_start(p_days);
  v_first date := (now() at time zone 'America/Sao_Paulo')::date - (p_days - 1);
begin
  return query
  with sold as (
    select (t.created_at at time zone 'America/Sao_Paulo')::date as d, count(*) as n, sum(t.amount) as amt
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
  from generate_series(v_first, v_first + (p_days - 1), interval '1 day') g
  left join sold s on s.d = g::date
  order by 1;
end;
$$;

/** Itens mais vendidos do período, por unidades. */
create function public.analytics_top_items(p_org uuid, p_days integer, p_limit integer default 5)
returns table (sku text, name text, units bigint, amount_cents bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind public.org_kind := private.analytics_guard(p_org, p_days);
  v_start timestamptz := private.analytics_start(p_days);
begin
  return query
  select t.sku, t.name, sum(t.qty)::bigint as units, sum(t.amount)::bigint
  from (
    select oi.sku, oi.name, oi.quantity as qty, oi.quantity * oi.unit_price_cents as amount
    from public.order_items oi join public.orders o on o.id = oi.order_id
    where v_kind = 'seller' and o.organization_id = p_org
      and o.created_at >= v_start and o.status <> 'cancelled'
    union all
    select soi.sku, soi.name, soi.quantity, soi.quantity * soi.unit_wholesale_cents
    from public.supplier_order_items soi join public.supplier_orders so on so.id = soi.supplier_order_id
    where v_kind = 'supplier' and so.organization_id = p_org
      and so.created_at >= v_start and so.status <> 'cancelled'
  ) t
  group by t.sku, t.name
  order by units desc, 4 desc, t.sku
  limit greatest(least(coalesce(p_limit, 5), 20), 1);
end;
$$;

grant execute on function public.analytics_overview(uuid, integer) to authenticated;
grant execute on function public.analytics_daily(uuid, integer) to authenticated;
grant execute on function public.analytics_top_items(uuid, integer, integer) to authenticated;
