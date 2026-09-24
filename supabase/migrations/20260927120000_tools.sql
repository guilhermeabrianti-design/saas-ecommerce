-- =====================================================================
-- Fase 20 · Ferramentas: preço-alvo, simulador de lucro e geradores com IA
--
--  * Cálculos no banco, com as MESMAS regras de taxa da Fase 15
--    (`private.match_fee_rule`, inclusive faixas de preço). Impostos, frete
--    pago pelo vendedor e antecipação são informados por quem usa: nada
--    fixo no código.
--  * Preço-alvo: menor preço que atinge a margem desejada, conferindo que a
--    regra de taxa usada é a que vale naquele preço.
--  * Modelo atual de venda: o vendedor recebe a venda no marketplace e paga
--    o custo (atacado do fornecedor ou custo próprio). A divisão com a
--    TheSigns chega com o checkout próprio (Fase 21).
--  * Geradores com IA (título, copy, roteiro de vídeo e de live) usam a
--    mesma Edge Function, a mesma cota diária e o mesmo controle de acesso
--    da descrição (Fase 13). O texto não é salvo.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Cálculos de preço
-- ---------------------------------------------------------------------
create function private.pricing_check(
  p_cost_cents bigint,
  p_shipping_cents bigint,
  p_tax_bps integer,
  p_anticipation_bps integer
)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_cost_cents is null or p_cost_cents not between 0 and 100000000000
     or p_shipping_cents is null or p_shipping_cents not between 0 and 100000000000
     or p_tax_bps is null or p_tax_bps not between 0 and 10000
     or p_anticipation_bps is null or p_anticipation_bps not between 0 and 10000 then
    raise exception 'pricing.invalid';
  end if;
end;
$$;

/** Lucro de uma venda unitária por um preço. Erros: pricing.invalid, fees.not_configured. */
create function public.pricing_simulate(
  p_provider public.marketplace_provider,
  p_listing_type text,
  p_category uuid,
  p_price_cents bigint,
  p_cost_cents bigint,
  p_shipping_cents bigint,
  p_tax_bps integer,
  p_anticipation_bps integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rule public.marketplace_fee_rules%rowtype;
  v_fee bigint;
  v_tax bigint;
  v_anticipation bigint;
  v_profit bigint;
begin
  if auth.uid() is null then
    raise exception 'pricing.forbidden' using errcode = '42501';
  end if;
  perform private.pricing_check(p_cost_cents, p_shipping_cents, p_tax_bps, p_anticipation_bps);
  if p_provider is null or nullif(btrim(p_listing_type), '') is null
     or p_price_cents is null or p_price_cents not between 1 and 100000000000 then
    raise exception 'pricing.invalid';
  end if;

  v_rule := private.match_fee_rule(p_provider, btrim(p_listing_type), p_category, null, p_price_cents);
  if v_rule.id is null then
    raise exception 'fees.not_configured';
  end if;

  v_fee := private.percent_of(p_price_cents, v_rule.percent_bps) + v_rule.fixed_cents_per_item;
  v_tax := private.percent_of(p_price_cents, p_tax_bps);
  v_anticipation := private.percent_of(p_price_cents, p_anticipation_bps);
  v_profit := p_price_cents - v_fee - v_tax - v_anticipation - p_cost_cents - p_shipping_cents;

  return jsonb_build_object(
    'price_cents', p_price_cents,
    'marketplace_fee_cents', v_fee,
    'fee_rule', jsonb_build_object(
      'id', v_rule.id, 'label', v_rule.label,
      'percent_bps', v_rule.percent_bps, 'fixed_cents_per_item', v_rule.fixed_cents_per_item),
    'tax_cents', v_tax,
    'anticipation_cents', v_anticipation,
    'cost_cents', p_cost_cents,
    'shipping_cents', p_shipping_cents,
    'profit_cents', v_profit,
    'margin_bps', round(v_profit::numeric * 10000 / p_price_cents)::integer
  );
end;
$$;

/**
 * Menor preço unitário cuja margem (lucro ÷ preço) atinge p_margin_bps.
 * Testa cada regra candidata (faixas de preço) e só aceita o preço se a
 * regra que vale nele for a mesma usada na conta.
 * Erros: pricing.invalid, fees.not_configured, pricing.unreachable.
 */
create function public.pricing_target(
  p_provider public.marketplace_provider,
  p_listing_type text,
  p_category uuid,
  p_cost_cents bigint,
  p_shipping_cents bigint,
  p_tax_bps integer,
  p_anticipation_bps integer,
  p_margin_bps integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_type text := nullif(btrim(p_listing_type), '');
  v_rule public.marketplace_fee_rules%rowtype;
  v_candidates integer := 0;
  v_denominator integer;
  v_price bigint;
  v_best bigint;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'pricing.forbidden' using errcode = '42501';
  end if;
  perform private.pricing_check(p_cost_cents, p_shipping_cents, p_tax_bps, p_anticipation_bps);
  if p_provider is null or v_type is null
     or p_margin_bps is null or p_margin_bps not between -10000 and 9900 then
    raise exception 'pricing.invalid';
  end if;

  for v_rule in
    select r.* from public.marketplace_fee_rules r
    left join public.categories c on c.id = p_category
    where r.is_active and r.provider = p_provider and r.listing_type = v_type
      and r.campaign is null
      and (r.category_id is null or r.category_id = p_category or r.category_id = c.parent_id)
  loop
    v_candidates := v_candidates + 1;
    v_denominator := 10000 - v_rule.percent_bps - p_tax_bps - p_anticipation_bps - p_margin_bps;
    continue when v_denominator <= 0;

    v_price := ceil(
      (p_cost_cents + p_shipping_cents + v_rule.fixed_cents_per_item)::numeric * 10000 / v_denominator
    )::bigint;
    v_price := greatest(v_price, v_rule.min_unit_price_cents, 1);
    continue when v_price > 100000000000;

    -- Arredondamentos em centavos: sobe até a margem ser atingida.
    for i in 1..5 loop
      exit when (v_price - private.percent_of(v_price, v_rule.percent_bps) - v_rule.fixed_cents_per_item
                 - private.percent_of(v_price, p_tax_bps) - private.percent_of(v_price, p_anticipation_bps)
                 - p_cost_cents - p_shipping_cents)::numeric * 10000 >= p_margin_bps::numeric * v_price;
      v_price := v_price + 1;
    end loop;

    -- Só vale se, nesse preço, a regra aplicada for esta (faixa e precedência).
    continue when (private.match_fee_rule(p_provider, v_type, p_category, null, v_price)).id
                  is distinct from v_rule.id;
    if v_best is null or v_price < v_best then
      v_best := v_price;
    end if;
  end loop;

  if v_candidates = 0 then
    raise exception 'fees.not_configured';
  end if;
  if v_best is null then
    raise exception 'pricing.unreachable';
  end if;

  v_result := public.pricing_simulate(
    p_provider, v_type, p_category, v_best, p_cost_cents, p_shipping_cents, p_tax_bps, p_anticipation_bps);
  return v_result || jsonb_build_object('target_margin_bps', p_margin_bps);
end;
$$;

-- ---------------------------------------------------------------------
-- IA: reserva de cota compartilhada e geradores
-- ---------------------------------------------------------------------

/** Trava por organização, confere a cota e registra o início. Quem chama já validou o acesso. */
create function private.ai_reserve(p_org uuid, p_feature text, p_product uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_used integer;
  v_usage uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('ai:' || p_org::text, 0));
  v_used := private.ai_used_today(p_org);
  if v_used >= private.ai_daily_limit() then
    raise exception 'ai.quota_exceeded';
  end if;
  insert into public.ai_usage (organization_id, user_id, feature, product_id)
  values (p_org, auth.uid(), p_feature, p_product)
  returning id into v_usage;
  return jsonb_build_object('usage_id', v_usage, 'remaining', private.ai_daily_limit() - v_used - 1);
end;
$$;

create or replace function public.ai_begin_description(p_org uuid, p_product uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products%rowtype;
begin
  if not private.has_org_role(p_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;

  select * into v_product from public.products p
  where p.id = p_product and p.organization_id = p_org;
  if v_product.id is null then
    raise exception 'ai.product_not_found';
  end if;

  return private.ai_reserve(p_org, 'product_description', p_product) || jsonb_build_object(
    'product', jsonb_build_object(
      'name', v_product.name,
      'brand', v_product.brand,
      'sku', v_product.sku,
      'description', v_product.description,
      'weight_grams', v_product.weight_grams,
      'variants', coalesce((
        select jsonb_agg(v.attributes order by v.created_at)
        from (select pv.attributes, pv.created_at from public.product_variants pv
              where pv.product_id = p_product and pv.is_active
              order by pv.created_at limit 20) v
      ), '[]'::jsonb)
    )
  );
end;
$$;

/**
 * Autoriza e reserva uma geração de ferramenta (título, copy, roteiros).
 * p_brief: orientação opcional de quem pede (até 300 caracteres), tratada
 * como conteúdo no prompt, nunca como instrução.
 */
create function public.ai_begin_generation(p_org uuid, p_product uuid, p_kind text, p_brief text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products%rowtype;
  v_brief text := nullif(btrim(coalesce(p_brief, '')), '');
begin
  if not private.has_org_role(p_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('title', 'ad_copy', 'video_script', 'live_script')
     or char_length(coalesce(v_brief, '')) > 300 then
    raise exception 'ai.invalid';
  end if;

  select * into v_product from public.products p
  where p.id = p_product and p.organization_id = p_org;
  if v_product.id is null then
    raise exception 'ai.product_not_found';
  end if;

  return private.ai_reserve(p_org, p_kind, p_product) || jsonb_build_object(
    'kind', p_kind,
    'brief', v_brief,
    'product', jsonb_build_object(
      'name', v_product.name,
      'brand', v_product.brand,
      'description', v_product.description,
      'price_cents', v_product.price_cents,
      'variants', coalesce((
        select jsonb_agg(v.attributes order by v.created_at)
        from (select pv.attributes, pv.created_at from public.product_variants pv
              where pv.product_id = p_product and pv.is_active
              order by pv.created_at limit 20) v
      ), '[]'::jsonb)
    )
  );
end;
$$;

grant execute on function public.pricing_simulate(
  public.marketplace_provider, text, uuid, bigint, bigint, bigint, integer, integer) to authenticated;
grant execute on function public.pricing_target(
  public.marketplace_provider, text, uuid, bigint, bigint, integer, integer, integer) to authenticated;
grant execute on function public.ai_begin_generation(uuid, uuid, text, text) to authenticated;
