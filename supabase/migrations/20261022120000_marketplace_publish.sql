-- =====================================================================
-- Fase 44 · Publicar na Shopee e na TikTok Shop
--
--  * A publicação da Fase 37 (Mercado Livre) vira genérica: as mesmas
--    regras (canal salvo e ligado, categoria, conta conectada e ativa, uma
--    execução por anúncio, vínculos de SKU ao concluir) valem para a
--    Shopee e a TikTok Shop. As funções do Mercado Livre continuam com o
--    mesmo nome e os mesmos erros (ml.*), por cima das genéricas.
--  * Atributos da categoria ficam no mesmo `attributes` (id e valor do
--    marketplace). Só o Mercado Livre usa o mapa de variações: na Shopee e
--    na TikTok Shop a característica da variação ("Cor") vai com o nome.
--  * Consultas de categoria e atributos da Shopee e da TikTok Shop usam o
--    token da conta conectada: `marketplace_lookup_connection` confere o
--    papel, aplica o limite e devolve a conexão.
--  * Novo estado "review": anúncio enviado e em análise no marketplace.
--  * Ao concluir, o vínculo de SKU guarda também a referência do item no
--    marketplace (`external_ref`, Fase 38), quando a publicação a conhece.
-- =====================================================================

alter table public.product_channel_configs drop constraint product_channel_configs_publish_status_check;
alter table public.product_channel_configs add constraint product_channel_configs_publish_status_check
  check (publish_status is null
    or publish_status in ('publishing', 'active', 'review', 'paused', 'closed', 'error'));

-- ---------------------------------------------------------------------
-- Atributos
-- ---------------------------------------------------------------------

/**
 * Atributos (e, no Mercado Livre, o mapa de variações) do anúncio de um
 * canal (owner/admin do vendedor). Salve o canal antes. Erros:
 * products.not_found, channels.sellers_only, channels.save_first,
 * channels.invalid.
 */
create function public.save_listing_attributes(
  p_product uuid,
  p_provider text,
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
    where c.product_id = p_product and c.provider::text = p_provider
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
     or p_variation_map is null or not private.valid_ml_variation_map(p_variation_map)
     or (p_provider <> 'mercadolivre' and p_variation_map <> '{}'::jsonb) then
    raise exception 'channels.invalid';
  end if;

  update public.product_channel_configs
  set attributes = v_attrs, variation_map = p_variation_map, updated_by = auth.uid()
  where product_id = p_product and provider::text = p_provider;
end;
$$;

create or replace function public.save_ml_listing_attributes(
  p_product uuid,
  p_attributes jsonb,
  p_variation_map jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  select public.save_listing_attributes(p_product, 'mercadolivre', p_attributes, p_variation_map)
$$;

/**
 * Conexão ativa do marketplace para consultar categorias e atributos
 * (owner/admin do vendedor, 120 consultas/10 min). Erros: org.forbidden,
 * channels.sellers_only, publish.not_connected, rate_limited.
 */
create function public.marketplace_lookup_connection(p_org uuid, p_provider text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn uuid;
begin
  if not private.has_org_role(p_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  if private.org_kind(p_org) <> 'seller' then
    raise exception 'channels.sellers_only' using errcode = '42501';
  end if;
  perform private.enforce_rate_limit(p_provider || '.lookup', auth.uid()::text, 120, 600);
  select c.id into v_conn from public.integration_connections c
  where c.organization_id = p_org and c.provider::text = p_provider and c.status = 'active'
  order by c.created_at desc
  limit 1;
  if v_conn is null then
    raise exception 'publish.not_connected';
  end if;
  return v_conn;
end;
$$;

-- ---------------------------------------------------------------------
-- Publicar (genérico)
-- ---------------------------------------------------------------------

/**
 * Começa publicar/atualizar (publish), pausar ou reativar o anúncio do
 * produto num marketplace (owner/admin do vendedor) e devolve o que a Edge
 * Function precisa. Erros: products.not_found, channels.sellers_only,
 * channels.save_first, channels.disabled, publish.category_required,
 * publish.not_connected, publish.connection_inactive, publish.not_published,
 * publish.busy, publish.no_active_variants, publish.invalid_action,
 * rate_limited.
 */
create function public.marketplace_publish_begin(p_product uuid, p_provider text, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products%rowtype;
  v_cfg public.product_channel_configs%rowtype;
  v_conn public.integration_connections%rowtype;
  v_run uuid := gen_random_uuid();
  v_has_variants boolean;
  v_variants jsonb;
  v_images jsonb;
  v_item uuid;
begin
  if p_provider is null or p_provider not in ('mercadolivre', 'shopee', 'tiktok')
     or p_action is null or p_action not in ('publish', 'pause', 'activate') then
    raise exception 'publish.invalid_action';
  end if;
  perform private.enforce_rate_limit(
    case p_provider when 'mercadolivre' then 'ml.publish' else p_provider || '.publish' end,
    auth.uid()::text, 30, 600
  );

  select * into v_product from public.products p where p.id = p_product;
  if v_product.id is null or not private.has_org_role(v_product.organization_id, '{owner,admin}') then
    raise exception 'products.not_found';
  end if;
  if private.org_kind(v_product.organization_id) <> 'seller' then
    raise exception 'channels.sellers_only' using errcode = '42501';
  end if;

  select * into v_cfg from public.product_channel_configs c
  where c.product_id = p_product and c.provider::text = p_provider
  for update;
  if v_cfg.id is null then
    raise exception 'channels.save_first';
  end if;
  if v_cfg.publish_status = 'publishing' and v_cfg.publish_started_at > now() - interval '10 minutes' then
    raise exception 'publish.busy';
  end if;
  if p_action <> 'publish' and v_cfg.external_id is null then
    raise exception 'publish.not_published';
  end if;
  if p_action = 'publish' then
    if not v_cfg.enabled then
      raise exception 'channels.disabled';
    end if;
    if v_cfg.marketplace_category is null then
      raise exception 'publish.category_required';
    end if;
  end if;

  -- Anúncio já publicado fica na conta em que foi criado.
  if v_cfg.external_id is not null then
    select * into v_conn from public.integration_connections c
    where c.id = v_cfg.connection_id and c.status = 'active';
    if v_conn.id is null then
      raise exception 'publish.connection_inactive';
    end if;
  else
    select * into v_conn from public.integration_connections c
    where c.organization_id = v_product.organization_id and c.provider::text = p_provider
      and c.status = 'active'
    order by c.created_at desc
    limit 1;
    if v_conn.id is null then
      raise exception 'publish.not_connected';
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
    raise exception 'publish.no_active_variants';
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
      connection_id = v_conn.id
  where id = v_cfg.id;

  return jsonb_build_object(
    'run_id', v_run,
    'action', p_action,
    'provider', p_provider,
    'organization_id', v_product.organization_id,
    'connection_id', v_conn.id,
    'account_id', v_conn.external_account_id,
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
 * vínculos de SKU (com a referência do item, quando vier); falha guarda o
 * erro e volta ao estado anterior (ou "error" quando nunca foi
 * publicado). Devolve false para execução desconhecida ou já concluída.
 */
create function public.marketplace_publish_finish(
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
  v_ref text;
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

  if p_status is null or p_status not in ('active', 'review', 'paused', 'closed') then
    raise exception 'publish.invalid_status';
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
    v_ref := nullif(v_link ->> 'ref', '');
    if v_ref is not null and v_ref !~ '^[A-Za-z0-9:_-]{1,120}$' then
      v_ref := null;
    end if;
    if v_item is null or v_sku = '' or not exists (
      select 1 from public.inventory_items i
      where i.id = v_item and i.product_id = v_cfg.product_id
    ) then
      continue;
    end if;
    delete from public.listing_links l
    where l.connection_id = v_cfg.connection_id and l.external_id = v_sku
      and l.inventory_item_id <> v_item;
    insert into public.listing_links (
      organization_id, connection_id, inventory_item_id, external_id, sync_stock, external_ref
    )
    values (v_cfg.organization_id, v_cfg.connection_id, v_item, v_sku, true, v_ref)
    on conflict (connection_id, inventory_item_id) do update
      set external_id = excluded.external_id,
          external_ref = coalesce(excluded.external_ref, public.listing_links.external_ref);
  end loop;
  return true;
end;
$$;

-- ---------------------------------------------------------------------
-- Mercado Livre por cima das genéricas (mesmos nomes e erros)
-- ---------------------------------------------------------------------

create or replace function public.ml_publish_begin(p_product uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_action is null or p_action not in ('publish', 'pause', 'activate') then
    raise exception 'ml.invalid_action';
  end if;
  return public.marketplace_publish_begin(p_product, 'mercadolivre', p_action);
exception when raise_exception then
  if sqlerrm like 'publish.%' then
    raise exception '%', 'ml.' || substr(sqlerrm, 9);
  end if;
  raise;
end;
$$;

create or replace function public.ml_publish_finish(
  p_run uuid,
  p_ok boolean,
  p_external_id text,
  p_external_url text,
  p_status text,
  p_error text,
  p_links jsonb
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select public.marketplace_publish_finish(
    p_run, p_ok, p_external_id, p_external_url, p_status, p_error, p_links
  )
$$;

-- ---------------------------------------------------------------------
-- Gamificação: anúncio publicado na Shopee ou na TikTok Shop
-- ---------------------------------------------------------------------

insert into public.gamification_rules (event, label, org_kind, points, daily_cap, position) values
  ('marketplace_listing_published', 'Anúncio publicado na Shopee ou na TikTok Shop', 'seller', 5, 10, 2)
on conflict (event) do nothing;

create or replace function private.gami_on_channel_config()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.external_id is not null and old.external_id is null then
    if new.provider = 'mercadolivre' then
      perform private.gami_award(new.organization_id, 'ml_listing_published', new.id::text);
    elsif new.provider in ('shopee', 'tiktok') then
      perform private.gami_award(new.organization_id, 'marketplace_listing_published', new.id::text);
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.save_listing_attributes(uuid, text, jsonb, jsonb) from public, anon;
revoke execute on function public.marketplace_lookup_connection(uuid, text) from public, anon;
revoke execute on function public.marketplace_publish_begin(uuid, text, text) from public, anon;
revoke execute on function public.marketplace_publish_finish(uuid, boolean, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.save_listing_attributes(uuid, text, jsonb, jsonb) to authenticated;
grant execute on function public.marketplace_lookup_connection(uuid, text) to authenticated;
grant execute on function public.marketplace_publish_begin(uuid, text, text) to authenticated;
grant execute on function public.marketplace_publish_finish(uuid, boolean, text, text, text, text, jsonb) to service_role;
