-- =====================================================================
-- Fase 37 · Publicar no Mercado Livre
--
--  * A configuração do canal (Fase 34) ganha o que o Mercado Livre exige
--    para publicar: atributos da categoria (`attributes`, escolhidos na
--    tela a partir da API de categorias) e o mapa das variações
--    (`variation_map`: "Cor" → COLOR).
--  * Publicar, atualizar, pausar e reativar passam pela Edge Function
--    `mercadolivre` (/publish). `ml_publish_begin` (JWT do vendedor) confere
--    tudo e devolve os dados do anúncio; `ml_publish_finish` (service role)
--    grava o resultado. Cada execução tem um `publish_run`: só ela pode
--    concluir (uma execução travada libera depois de 10 minutos).
--  * Ao publicar, cada SKU vira um vínculo (`listing_links`, SKU do
--    vendedor = SELLER_SKU no Mercado Livre): pedidos entram sozinhos e o
--    estoque passa a sincronizar pela fila da Fase 14.
--  * Produto importado anuncia o estoque do fornecedor (link_available).
-- =====================================================================

/** Atributos do Mercado Livre: [{id, value_id?, value_name?}], até 80. */
create function private.valid_ml_attributes(p_attrs jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_attrs) = 'array'
    and jsonb_array_length(p_attrs) <= 80
    and not exists (
      select 1 from jsonb_array_elements(p_attrs) a(v)
      where jsonb_typeof(a.v) <> 'object'
        or exists (select 1 from jsonb_object_keys(a.v) k where k not in ('id', 'value_id', 'value_name'))
        or coalesce(a.v ->> 'id', '') !~ '^[A-Z0-9_]{1,60}$'
        -- SKU e condição são sempre preenchidos pela TheSigns.
        or a.v ->> 'id' in ('SELLER_SKU', 'ITEM_CONDITION')
        or (a.v ? 'value_id' and (jsonb_typeof(a.v -> 'value_id') <> 'string'
            or (a.v ->> 'value_id') !~ '^[A-Za-z0-9_-]{1,40}$'))
        or (a.v ? 'value_name' and (jsonb_typeof(a.v -> 'value_name') <> 'string'
            or char_length(btrim(a.v ->> 'value_name')) not between 1 and 255))
        or not (a.v ? 'value_id' or a.v ? 'value_name')
    )
    and (select count(distinct a.v ->> 'id') from jsonb_array_elements(p_attrs) a(v))
      = jsonb_array_length(p_attrs)
$$;

/** Mapa das variações: {"Cor": "COLOR"}, até 3 (o limite de atributos de variação). */
create function private.valid_ml_variation_map(p_map jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_map) = 'object'
    and (select count(*) from jsonb_object_keys(p_map)) <= 3
    and not exists (
      select 1 from jsonb_each(p_map) e(key, value)
      where char_length(e.key) not between 1 and 30
        or jsonb_typeof(e.value) <> 'string'
        or (e.value #>> '{}') !~ '^[A-Z0-9_]{1,60}$'
    )
$$;

alter table public.product_channel_configs
  add column attributes jsonb not null default '[]'::jsonb
    check (private.valid_ml_attributes(attributes)),
  add column variation_map jsonb not null default '{}'::jsonb
    check (private.valid_ml_variation_map(variation_map)),
  add column connection_id uuid references public.integration_connections (id) on delete set null,
  add column external_id text check (external_id is null or external_id ~ '^[A-Za-z0-9_-]{1,40}$'),
  add column external_url text
    check (external_url is null or (external_url ~ '^https://' and char_length(external_url) <= 500)),
  add column publish_status text
    check (publish_status is null or publish_status in ('publishing', 'active', 'paused', 'closed', 'error')),
  add column previous_publish_status text,
  add column publish_run uuid,
  add column publish_action text check (publish_action is null or publish_action in ('publish', 'pause', 'activate')),
  add column publish_started_at timestamptz,
  add column last_error text check (last_error is null or char_length(last_error) <= 1000),
  add column published_at timestamptz;

create unique index product_channel_configs_run_key
  on public.product_channel_configs (publish_run) where publish_run is not null;

/**
 * Atributos e mapa de variações do anúncio no Mercado Livre (owner/admin
 * do vendedor). Salve o canal antes. Erros: products.not_found,
 * channels.sellers_only, channels.save_first, channels.invalid.
 */
create function public.save_ml_listing_attributes(
  p_product uuid,
  p_attributes jsonb,
  p_variation_map jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_attrs jsonb;
begin
  select p.organization_id into v_org from public.products p where p.id = p_product;
  if v_org is null or not private.has_org_role(v_org, '{owner,admin}') then
    raise exception 'products.not_found';
  end if;
  if private.org_kind(v_org) <> 'seller' then
    raise exception 'channels.sellers_only' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.product_channel_configs c
    where c.product_id = p_product and c.provider = 'mercadolivre'
  ) then
    raise exception 'channels.save_first';
  end if;

  -- Sem espaços sobrando nos valores digitados.
  select coalesce(jsonb_agg(
    case when a.v ? 'value_name'
      then jsonb_set(a.v, '{value_name}', to_jsonb(btrim(a.v ->> 'value_name')))
      else a.v end), '[]'::jsonb)
  into v_attrs
  from jsonb_array_elements(case when jsonb_typeof(p_attributes) = 'array' then p_attributes else '[]'::jsonb end) a(v)
  where jsonb_typeof(a.v) = 'object';

  if p_attributes is null or jsonb_typeof(p_attributes) <> 'array'
     or jsonb_array_length(v_attrs) <> jsonb_array_length(p_attributes)
     or not private.valid_ml_attributes(v_attrs)
     or p_variation_map is null or not private.valid_ml_variation_map(p_variation_map) then
    raise exception 'channels.invalid';
  end if;

  update public.product_channel_configs
  set attributes = v_attrs, variation_map = p_variation_map, updated_by = auth.uid()
  where product_id = p_product and provider = 'mercadolivre';
end;
$$;

/** Consultas à API de categorias do Mercado Livre pela Edge Function (vendedor, com limite). */
create function public.ml_lookup_allowed()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_seller_member() then
    raise exception 'channels.sellers_only' using errcode = '42501';
  end if;
  perform private.enforce_rate_limit('ml.lookup', auth.uid()::text, 120, 600);
end;
$$;

/**
 * Começa publicar/atualizar (publish), pausar ou reativar o anúncio do
 * produto no Mercado Livre (owner/admin do vendedor) e devolve os dados que
 * a Edge Function precisa. Erros: products.not_found, channels.sellers_only,
 * channels.save_first, channels.disabled, ml.category_required,
 * ml.not_connected, ml.connection_inactive, ml.not_published, ml.busy,
 * ml.no_active_variants, ml.invalid_action, rate_limited.
 */
create function public.ml_publish_begin(p_product uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products%rowtype;
  v_cfg public.product_channel_configs%rowtype;
  v_conn uuid;
  v_run uuid := gen_random_uuid();
  v_has_variants boolean;
  v_variants jsonb;
  v_images jsonb;
  v_item uuid;
begin
  if p_action is null or p_action not in ('publish', 'pause', 'activate') then
    raise exception 'ml.invalid_action';
  end if;
  perform private.enforce_rate_limit('ml.publish', auth.uid()::text, 30, 600);

  select * into v_product from public.products p where p.id = p_product;
  if v_product.id is null or not private.has_org_role(v_product.organization_id, '{owner,admin}') then
    raise exception 'products.not_found';
  end if;
  if private.org_kind(v_product.organization_id) <> 'seller' then
    raise exception 'channels.sellers_only' using errcode = '42501';
  end if;

  select * into v_cfg from public.product_channel_configs c
  where c.product_id = p_product and c.provider = 'mercadolivre'
  for update;
  if v_cfg.id is null then
    raise exception 'channels.save_first';
  end if;
  if v_cfg.publish_status = 'publishing' and v_cfg.publish_started_at > now() - interval '10 minutes' then
    raise exception 'ml.busy';
  end if;
  if p_action <> 'publish' and v_cfg.external_id is null then
    raise exception 'ml.not_published';
  end if;
  if p_action = 'publish' then
    if not v_cfg.enabled then
      raise exception 'channels.disabled';
    end if;
    if v_cfg.marketplace_category is null then
      raise exception 'ml.category_required';
    end if;
  end if;

  -- Anúncio já publicado fica na conta em que foi criado.
  if v_cfg.external_id is not null then
    select c.id into v_conn from public.integration_connections c
    where c.id = v_cfg.connection_id and c.status = 'active';
    if v_conn is null then
      raise exception 'ml.connection_inactive';
    end if;
  else
    select c.id into v_conn from public.integration_connections c
    where c.organization_id = v_product.organization_id and c.provider = 'mercadolivre'
      and c.status = 'active'
    order by c.created_at desc
    limit 1;
    if v_conn is null then
      raise exception 'ml.not_connected';
    end if;
  end if;

  v_has_variants := exists (select 1 from public.product_variants v where v.product_id = p_product);
  select coalesce(jsonb_agg(jsonb_build_object(
      'inventory_item_id', i.id,
      'sku', v.sku,
      'attributes', v.attributes,
      'gtin', v.gtin,
      'available', coalesce(private.link_available(i.id), 0)
    ) order by v.created_at), '[]'::jsonb)
  into v_variants
  from public.product_variants v
  join public.inventory_items i on i.variant_id = v.id
  where v.product_id = p_product and v.is_active;
  if v_has_variants and jsonb_array_length(v_variants) = 0 then
    raise exception 'ml.no_active_variants';
  end if;
  select i.id into v_item from public.inventory_items i
  where i.product_id = p_product and i.variant_id is null;

  -- Fotos do produto; importado sem fotos próprias usa as do fornecedor.
  select coalesce(jsonb_agg(i.storage_path order by i.position), '[]'::jsonb) into v_images
  from public.product_images i where i.product_id = p_product;
  if jsonb_array_length(v_images) = 0 and v_product.source_listing_id is not null then
    select coalesce(jsonb_agg(i.storage_path order by i.position), '[]'::jsonb) into v_images
    from public.catalog_listings l
    join public.product_images i on i.product_id = l.product_id
    where l.id = v_product.source_listing_id;
  end if;

  update public.product_channel_configs
  set previous_publish_status = case when publish_status = 'publishing'
        then previous_publish_status else publish_status end,
      publish_status = 'publishing',
      publish_run = v_run,
      publish_action = p_action,
      publish_started_at = now(),
      connection_id = v_conn
  where id = v_cfg.id;

  return jsonb_build_object(
    'run_id', v_run,
    'action', p_action,
    'organization_id', v_product.organization_id,
    'connection_id', v_conn,
    'external_id', v_cfg.external_id,
    'config', jsonb_build_object(
      'title', v_cfg.title,
      'price_cents', v_cfg.price_cents,
      'listing_type', v_cfg.listing_type,
      'category', v_cfg.marketplace_category,
      'free_shipping', v_cfg.free_shipping,
      'attributes', v_cfg.attributes,
      'variation_map', v_cfg.variation_map
    ),
    'product', jsonb_build_object(
      'sku', v_product.sku,
      'name', v_product.name,
      'description', v_product.description,
      'brand', v_product.brand,
      'gtin', v_product.gtin,
      'weight_grams', v_product.weight_grams,
      'length_mm', v_product.length_mm,
      'width_mm', v_product.width_mm,
      'height_mm', v_product.height_mm,
      'inventory_item_id', case when v_has_variants then null else v_item end,
      'available', case when v_has_variants then null
        else coalesce(private.link_available(v_item), 0) end
    ),
    'variants', v_variants,
    'images', v_images
  );
end;
$$;

/**
 * Resultado de uma execução (service role). Sucesso grava o anúncio e os
 * vínculos de SKU; falha guarda o erro e volta ao estado anterior (ou
 * "erro" quando nunca foi publicado). Devolve false para execução
 * desconhecida ou já concluída.
 */
create function public.ml_publish_finish(
  p_run uuid,
  p_ok boolean,
  p_external_id text,
  p_external_url text,
  p_status text,
  p_error text,
  p_links jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg public.product_channel_configs%rowtype;
  v_link jsonb;
  v_item uuid;
  v_sku text;
begin
  select * into v_cfg from public.product_channel_configs c
  where c.publish_run = p_run and c.publish_status = 'publishing'
  for update;
  if v_cfg.id is null then
    return false;
  end if;

  if not coalesce(p_ok, false) then
    update public.product_channel_configs
    set publish_status = case when external_id is null then 'error'
          else coalesce(previous_publish_status, 'active') end,
        last_error = left(coalesce(nullif(btrim(p_error), ''), 'Falha ao publicar.'), 1000),
        publish_run = null
    where id = v_cfg.id;
    return true;
  end if;

  if p_status is null or p_status not in ('active', 'paused', 'closed') then
    raise exception 'ml.invalid_status';
  end if;

  update public.product_channel_configs
  set external_id = coalesce(nullif(btrim(p_external_id), ''), external_id),
      external_url = coalesce(nullif(btrim(p_external_url), ''), external_url),
      publish_status = p_status,
      last_error = null,
      publish_run = null,
      published_at = case when v_cfg.publish_action = 'publish' then now() else published_at end
  where id = v_cfg.id;

  -- Vínculos SKU ↔ estoque (só itens do próprio produto).
  for v_link in select * from jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) loop
    v_item := nullif(v_link ->> 'inventory_item_id', '')::uuid;
    v_sku := btrim(coalesce(v_link ->> 'sku', ''));
    if v_item is null or v_sku = '' or not exists (
      select 1 from public.inventory_items i
      where i.id = v_item and i.product_id = v_cfg.product_id
    ) then
      continue;
    end if;
    delete from public.listing_links l
    where l.connection_id = v_cfg.connection_id and l.external_id = v_sku
      and l.inventory_item_id <> v_item;
    insert into public.listing_links (organization_id, connection_id, inventory_item_id, external_id, sync_stock)
    values (v_cfg.organization_id, v_cfg.connection_id, v_item, v_sku, true)
    on conflict (connection_id, inventory_item_id) do update set external_id = excluded.external_id;
  end loop;
  return true;
end;
$$;

revoke execute on function private.valid_ml_attributes(jsonb) from public, anon, authenticated;
revoke execute on function private.valid_ml_variation_map(jsonb) from public, anon, authenticated;
revoke execute on function public.save_ml_listing_attributes(uuid, jsonb, jsonb) from public, anon;
revoke execute on function public.ml_lookup_allowed() from public, anon;
revoke execute on function public.ml_publish_begin(uuid, text) from public, anon;
revoke execute on function public.ml_publish_finish(uuid, boolean, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.save_ml_listing_attributes(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.ml_lookup_allowed() to authenticated;
grant execute on function public.ml_publish_begin(uuid, text) to authenticated;
grant execute on function public.ml_publish_finish(uuid, boolean, text, text, text, text, jsonb) to service_role;
