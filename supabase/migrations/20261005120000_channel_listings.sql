-- =====================================================================
-- Fase 29 · Gerenciador de anúncios e publicação (Shopify e WooCommerce)
--
--  * Anúncio no canal (`channel_listings`): um produto do vendedor numa
--    conexão, com título, descrição e preço próprios. Criar, editar,
--    duplicar para outra conexão, publicar, pausar e reativar.
--  * Publicar/pausar/reativar é feito pela Edge Function `listings`:
--    cada etapa real (validação, credenciais, produto no marketplace,
--    estoque, vínculos) é gravada em `channel_listing_steps` na hora em
--    que acontece — a tela mostra exatamente isso, sem animação encenada.
--  * Ao publicar, cada SKU vira um vínculo (`listing_links`): pedidos do
--    marketplace entram sozinhos e o estoque passa a sincronizar.
--  * Produto importado do catálogo (dropshipping) anuncia o estoque do
--    fornecedor: mudanças no estoque dele vão para a fila de envio.
-- =====================================================================

create type public.channel_listing_status as enum ('draft', 'publishing', 'active', 'paused', 'error');

create table public.channel_listings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  connection_id uuid not null,
  product_id uuid not null references public.products (id) on delete cascade,
  title text not null check (title = btrim(title) and char_length(title) between 2 and 255),
  description text check (description is null or char_length(description) <= 20000),
  -- Nulo = preço do produto; variação com preço próprio mantém o dela.
  price_cents bigint check (price_cents is null or price_cents between 1 and 100000000000),
  status public.channel_listing_status not null default 'draft',
  -- Estado anterior à publicação em andamento (para voltar se falhar antes do marketplace).
  previous_status public.channel_listing_status,
  run_id uuid,
  run_action text check (run_action is null or run_action in ('publish', 'pause', 'activate')),
  run_started_at timestamptz,
  external_id text check (external_id is null or char_length(external_id) between 1 and 120),
  external_url text check (external_url is null or (external_url ~ '^https://' and char_length(external_url) <= 500)),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  last_published_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, connection_id)
    references public.integration_connections (organization_id, id) on delete cascade,
  unique (connection_id, product_id)
);

create index channel_listings_org_idx on public.channel_listings (organization_id, updated_at desc);

create trigger channel_listings_set_updated_at
  before update on public.channel_listings
  for each row execute function public.set_updated_at();

create table public.channel_listing_steps (
  id bigint generated always as identity primary key,
  listing_id uuid not null references public.channel_listings (id) on delete cascade,
  organization_id uuid not null,
  run_id uuid not null,
  action text not null check (action in ('publish', 'pause', 'activate')),
  step text not null check (step in ('validate', 'credentials', 'product', 'stock', 'links', 'status', 'done')),
  status text not null check (status in ('ok', 'error')),
  message text check (message is null or char_length(message) <= 500),
  created_at timestamptz not null default now()
);

create index channel_listing_steps_listing_idx on public.channel_listing_steps (listing_id, id desc);

revoke all on table public.channel_listings from anon, authenticated;
revoke all on table public.channel_listing_steps from anon, authenticated;
grant select on table public.channel_listings to authenticated;
grant select on table public.channel_listing_steps to authenticated;

alter table public.channel_listings enable row level security;
alter table public.channel_listing_steps enable row level security;

create policy "channel_listings: owner/admin leem"
  on public.channel_listings for select to authenticated
  using (private.has_org_role(organization_id, '{owner,admin}'));

create policy "channel_listing_steps: owner/admin leem"
  on public.channel_listing_steps for select to authenticated
  using (private.has_org_role(organization_id, '{owner,admin}'));

-- ---------------------------------------------------------------------
-- Estoque anunciável
-- ---------------------------------------------------------------------

/**
 * Item de estoque do fornecedor por trás de uma cópia importada (nulo =
 * produto próprio do vendedor).
 */
create function private.dropship_source_item(p_item uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select si.id
  from public.inventory_items i
  join public.products p on p.id = i.product_id
  join public.catalog_listings l on l.id = p.source_listing_id
  left join public.product_variants v on v.id = i.variant_id
  join public.inventory_items si on si.product_id = l.product_id
    and si.variant_id is not distinct from v.source_variant_id
  where i.id = p_item
$$;

/** Disponível para anunciar: do fornecedor (importado) ou o próprio. */
create function private.link_available(p_item uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(i.on_hand - i.reserved, 0)::integer
  from public.inventory_items i
  where i.id = coalesce(private.dropship_source_item(p_item), p_item)
$$;

/** Estoque do fornecedor mudou: enfileira o envio para os anúncios das cópias importadas. */
create function private.enqueue_dropship_stock_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.stock_sync_outbox (organization_id, link_id, available)
  select l.organization_id, l.id, greatest(new.on_hand - new.reserved, 0)
  from public.catalog_listings cl
  join public.products sp on sp.source_listing_id = cl.id
  join public.inventory_items si on si.product_id = sp.id
  left join public.product_variants sv on sv.id = si.variant_id
  join public.listing_links l on l.inventory_item_id = si.id
  join public.integration_connections c on c.id = l.connection_id
  where cl.product_id = new.product_id
    and sv.source_variant_id is not distinct from new.variant_id
    and l.sync_stock and c.status = 'active'
  on conflict (link_id) where claimed_at is null and done_at is null
  do update set available = excluded.available, created_at = now(), next_attempt_at = now();
  return new;
end;
$$;

create trigger inventory_items_enqueue_dropship_sync
  after update of on_hand, reserved on public.inventory_items
  for each row
  when (old.on_hand - old.reserved is distinct from new.on_hand - new.reserved)
  execute function private.enqueue_dropship_stock_sync();

-- ---------------------------------------------------------------------
-- Vendedor
-- ---------------------------------------------------------------------

/** Conexão da organização, ativa e de um marketplace com publicação. */
create function private.publishable_connection(p_connection uuid, p_org uuid)
returns public.integration_connections
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_conn public.integration_connections%rowtype;
begin
  select * into v_conn from public.integration_connections c
  where c.id = p_connection and c.organization_id = p_org;
  if v_conn.id is null then
    raise exception 'listings.invalid_connection';
  end if;
  if v_conn.status <> 'active' then
    raise exception 'listings.connection_inactive';
  end if;
  if v_conn.provider not in ('shopify', 'woocommerce') then
    raise exception 'listings.provider_unavailable';
  end if;
  return v_conn;
end;
$$;

/** Cria (p_listing nulo) ou edita um anúncio. Owner/admin do vendedor. */
create function public.save_channel_listing(
  p_org uuid,
  p_listing uuid,
  p_connection uuid,
  p_product uuid,
  p_title text,
  p_description text,
  p_price_cents bigint
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.channel_listings%rowtype;
  v_title text := btrim(coalesce(p_title, ''));
  v_id uuid;
begin
  if not private.has_org_role(p_org, '{owner,admin}') or private.org_kind(p_org) <> 'seller' then
    raise exception 'listings.forbidden' using errcode = '42501';
  end if;
  if char_length(v_title) not between 2 and 255
     or char_length(coalesce(p_description, '')) > 20000
     or (p_price_cents is not null and p_price_cents < 1) then
    raise exception 'listings.invalid';
  end if;

  if p_listing is null then
    perform private.publishable_connection(p_connection, p_org);
    if not exists (select 1 from public.products p where p.id = p_product and p.organization_id = p_org) then
      raise exception 'listings.invalid_product';
    end if;
    begin
      insert into public.channel_listings (
        organization_id, connection_id, product_id, title, description, price_cents, created_by
      ) values (
        p_org, p_connection, p_product, v_title, nullif(p_description, ''), p_price_cents, auth.uid()
      )
      returning id into v_id;
    exception when unique_violation then
      raise exception 'listings.already_exists';
    end;
    return v_id;
  end if;

  select * into v_row from public.channel_listings l
  where l.id = p_listing and l.organization_id = p_org for update;
  if v_row.id is null then
    raise exception 'listings.not_found';
  end if;
  if v_row.status = 'publishing' then
    raise exception 'listings.busy';
  end if;
  update public.channel_listings
  set title = v_title, description = nullif(p_description, ''), price_cents = p_price_cents
  where id = p_listing;
  return p_listing;
end;
$$;

/** Copia o anúncio (rascunho) para outra conexão. */
create function public.duplicate_channel_listing(p_listing uuid, p_connection uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.channel_listings%rowtype;
begin
  select * into v_row from public.channel_listings l where l.id = p_listing;
  if v_row.id is null or not private.has_org_role(v_row.organization_id, '{owner,admin}') then
    raise exception 'listings.not_found';
  end if;
  return public.save_channel_listing(
    v_row.organization_id, null, p_connection, v_row.product_id, v_row.title, v_row.description,
    v_row.price_cents
  );
end;
$$;

/** Apaga um rascunho que nunca foi publicado. */
create function public.delete_channel_listing(p_listing uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.channel_listings%rowtype;
begin
  select * into v_row from public.channel_listings l where l.id = p_listing for update;
  if v_row.id is null or not private.has_org_role(v_row.organization_id, '{owner,admin}') then
    raise exception 'listings.not_found';
  end if;
  if v_row.external_id is not null or v_row.status = 'publishing' then
    raise exception 'listings.already_published';
  end if;
  delete from public.channel_listings where id = p_listing;
end;
$$;

-- ---------------------------------------------------------------------
-- Publicação (Edge Function `listings`)
-- ---------------------------------------------------------------------

/**
 * Começa uma ação (publish | pause | activate) com o JWT de quem pediu:
 * confere papel, conexão e produto, marca "publicando", registra a etapa
 * de validação e devolve o que a função precisa enviar ao marketplace.
 */
create function public.channel_listing_begin(p_listing uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.channel_listings%rowtype;
  v_conn public.integration_connections%rowtype;
  v_product public.products%rowtype;
  v_run uuid := gen_random_uuid();
  v_variants jsonb;
  v_options jsonb;
  v_problem text;
begin
  select * into v_row from public.channel_listings l where l.id = p_listing for update;
  if v_row.id is null or not private.has_org_role(v_row.organization_id, '{owner,admin}') then
    raise exception 'listings.not_found';
  end if;
  if p_action not in ('publish', 'pause', 'activate') then
    raise exception 'listings.invalid';
  end if;
  -- Uma ação por vez (uma travada há mais de 10 min pode ser retomada).
  if v_row.status = 'publishing' and v_row.run_started_at > now() - interval '10 minutes' then
    raise exception 'listings.busy';
  end if;
  if p_action in ('pause', 'activate') and v_row.external_id is null then
    raise exception 'listings.not_published';
  end if;
  v_conn := private.publishable_connection(v_row.connection_id, v_row.organization_id);

  select * into v_product from public.products p where p.id = v_row.product_id;
  if p_action = 'publish' then
    if v_product.status <> 'active' then
      v_problem := 'listings.product_inactive';
    elsif v_product.source_listing_id is not null and not private.visible_listing(v_product.source_listing_id) then
      v_problem := 'listings.product_unavailable';
    end if;
  end if;

  -- Opções (Cor, Tamanho…) e variações vendáveis com SKU, preço e disponível.
  select coalesce(jsonb_agg(distinct k.key), '[]'::jsonb) into v_options
  from public.product_variants v, jsonb_object_keys(v.attributes) k(key)
  where v.product_id = v_product.id and v.is_active;

  select coalesce(jsonb_agg(jsonb_build_object(
      'inventory_item_id', i.id,
      'sku', coalesce(v.sku, v_product.sku),
      'price_cents', coalesce(v.price_cents, v_row.price_cents, v_product.price_cents),
      'available', private.link_available(i.id),
      'options', coalesce(v.attributes, '{}'::jsonb)
    ) order by coalesce(v.sku, v_product.sku)), '[]'::jsonb) into v_variants
  from public.inventory_items i
  left join public.product_variants v on v.id = i.variant_id
  where i.product_id = v_product.id
    and (
      (i.variant_id is null and not exists (select 1 from public.product_variants pv where pv.product_id = v_product.id))
      or (v.is_active and (v_product.source_listing_id is null or v.source_variant_id is not null))
    );

  if v_problem is null and p_action = 'publish' then
    if jsonb_array_length(v_variants) = 0 then
      v_problem := 'listings.no_variants';
    elsif exists (
      select 1 from jsonb_array_elements(v_variants) x
      where (x ->> 'price_cents') is null or (x ->> 'price_cents')::bigint < 1
    ) then
      v_problem := 'listings.invalid_price';
    elsif jsonb_array_length(v_options) > 0 and exists (
      select 1 from jsonb_array_elements(v_variants) x
      where (select count(*) from jsonb_object_keys(x -> 'options')) <> jsonb_array_length(v_options)
    ) then
      v_problem := 'listings.inconsistent_options';
    end if;
  end if;

  insert into public.channel_listing_steps (listing_id, organization_id, run_id, action, step, status, message)
  values (p_listing, v_row.organization_id, v_run, p_action, 'validate',
    case when v_problem is null then 'ok' else 'error' end,
    case v_problem
      when 'listings.product_inactive' then 'Produto não está ativo no seu catálogo.'
      when 'listings.product_unavailable' then 'O fornecedor tirou este produto do catálogo.'
      when 'listings.no_variants' then 'Nenhuma variação ativa para anunciar.'
      when 'listings.invalid_price' then 'Há variação sem preço.'
      when 'listings.inconsistent_options' then 'As variações não têm as mesmas opções (ex.: Cor e Tamanho em todas).'
      else 'Dados conferidos: ' || jsonb_array_length(v_variants) || ' variação(ões).'
    end);

  if v_problem is not null then
    update public.channel_listings
    set last_error = left(v_problem, 500),
        status = case when status = 'publishing' then coalesce(previous_status, 'draft') else status end
    where id = p_listing;
    return jsonb_build_object('run_id', v_run, 'error', v_problem);
  end if;

  update public.channel_listings set
    previous_status = case when status = 'publishing' then previous_status else status end,
    status = 'publishing', run_id = v_run, run_action = p_action, run_started_at = now(), last_error = null
  where id = p_listing;

  return jsonb_build_object(
    'run_id', v_run,
    'action', p_action,
    'connection_id', v_conn.id,
    'provider', v_conn.provider,
    'account', v_conn.external_account_id,
    'external_id', v_row.external_id,
    -- Estado no marketplace ao final: publicar um pausado não o reativa.
    'target_status', case
      when p_action = 'pause' then 'paused'
      when p_action = 'activate' then 'active'
      when v_row.status = 'paused' or (v_row.status = 'publishing' and v_row.previous_status = 'paused') then 'paused'
      else 'active'
    end,
    'title', v_row.title,
    'description', v_row.description,
    'option_names', v_options,
    'variants', v_variants,
    'image_paths', coalesce(
      (select jsonb_agg(im.storage_path order by im.position) from public.product_images im
       where im.product_id = v_product.id),
      (select jsonb_agg(im.storage_path order by im.position) from public.product_images im
       join public.catalog_listings cl on cl.product_id = im.product_id
       where cl.id = v_product.source_listing_id),
      '[]'::jsonb)
  );
end;
$$;

/** Registra uma etapa da ação em andamento (service role). */
create function public.channel_listing_step(
  p_listing uuid,
  p_run uuid,
  p_step text,
  p_status text,
  p_message text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.channel_listings%rowtype;
begin
  select * into v_row from public.channel_listings l where l.id = p_listing;
  if v_row.id is null or v_row.run_id is distinct from p_run then
    raise exception 'listings.stale_run';
  end if;
  insert into public.channel_listing_steps (listing_id, organization_id, run_id, action, step, status, message)
  values (p_listing, v_row.organization_id, p_run, v_row.run_action, p_step, p_status, left(p_message, 500));
end;
$$;

/**
 * Conclui a ação (service role). Sucesso: guarda o id/URL no marketplace,
 * cria os vínculos de SKU (pedidos e estoque) e o estado final. Falha:
 * estado de erro com a mensagem (sem segredos).
 * p_links: [{inventory_item_id, sku}].
 */
create function public.channel_listing_finish(
  p_listing uuid,
  p_run uuid,
  p_ok boolean,
  p_external_id text,
  p_external_url text,
  p_error text,
  p_links jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.channel_listings%rowtype;
  v_final public.channel_listing_status;
  v_linked integer := 0;
  v_conflicts integer := 0;
  r record;
begin
  select * into v_row from public.channel_listings l where l.id = p_listing for update;
  if v_row.id is null or v_row.run_id is distinct from p_run then
    raise exception 'listings.stale_run';
  end if;

  if not p_ok then
    update public.channel_listings set
      status = case when v_row.external_id is null and v_row.run_action = 'publish' then 'error'
                    else coalesce(v_row.previous_status, 'error') end,
      last_error = left(coalesce(p_error, 'Falha sem detalhe.'), 500),
      run_id = null
    where id = p_listing;
    insert into public.channel_listing_steps (listing_id, organization_id, run_id, action, step, status, message)
    values (p_listing, v_row.organization_id, p_run, v_row.run_action, 'done', 'error', left(p_error, 500));
    insert into public.integration_events (organization_id, connection_id, direction, kind, external_id, status, message)
    values (v_row.organization_id, v_row.connection_id, 'outbound', 'listing.' || v_row.run_action,
      coalesce(p_external_id, v_row.external_id), 'error', left(v_row.title || ': ' || coalesce(p_error, ''), 500));
    return;
  end if;

  -- Vínculos SKU → item (um SKU só aponta para um item por conexão).
  for r in
    select (x ->> 'inventory_item_id')::uuid as item, btrim(x ->> 'sku') as sku
    from jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) x
  loop
    if not exists (
      select 1 from public.inventory_items i
      where i.id = r.item and i.product_id = v_row.product_id
    ) or r.sku is null or r.sku = '' then
      continue;
    end if;
    if exists (
      select 1 from public.listing_links l
      where l.connection_id = v_row.connection_id and l.external_id = r.sku and l.inventory_item_id <> r.item
    ) or exists (
      select 1 from public.listing_links l
      where l.connection_id = v_row.connection_id and l.inventory_item_id = r.item and l.external_id <> r.sku
    ) then
      v_conflicts := v_conflicts + 1;
      continue;
    end if;
    insert into public.listing_links (organization_id, connection_id, inventory_item_id, external_id)
    values (v_row.organization_id, v_row.connection_id, r.item, r.sku)
    on conflict (connection_id, external_id) do nothing;
    v_linked := v_linked + 1;
  end loop;

  -- Atualizar um anúncio pausado mantém pausado.
  v_final := case
    when v_row.run_action = 'pause' then 'paused'
    when v_row.run_action = 'activate' then 'active'
    when v_row.previous_status = 'paused' then 'paused'
    else 'active'
  end;
  update public.channel_listings set
    status = v_final,
    external_id = coalesce(p_external_id, external_id),
    external_url = coalesce(p_external_url, external_url),
    last_error = case when v_conflicts > 0
      then v_conflicts || ' SKU(s) já vinculados a outro item nesta conexão: confira em Integrações.' end,
    last_published_at = case when v_row.run_action = 'publish' then now() else last_published_at end,
    run_id = null
  where id = p_listing;

  if v_row.run_action = 'publish' then
    insert into public.channel_listing_steps (listing_id, organization_id, run_id, action, step, status, message)
    values (p_listing, v_row.organization_id, p_run, 'publish', 'links',
      case when v_conflicts > 0 then 'error' else 'ok' end,
      v_linked || ' SKU(s) vinculados' || case when v_conflicts > 0 then ', ' || v_conflicts || ' em conflito' else '' end || '.');
  end if;
  insert into public.channel_listing_steps (listing_id, organization_id, run_id, action, step, status, message)
  values (p_listing, v_row.organization_id, p_run, v_row.run_action, 'done', 'ok',
    case v_final when 'paused' then 'Anúncio pausado no marketplace.' else 'Anúncio ativo no marketplace.' end);
  insert into public.integration_events (organization_id, connection_id, direction, kind, external_id, status, message)
  values (v_row.organization_id, v_row.connection_id, 'outbound', 'listing.' || v_row.run_action,
    coalesce(p_external_id, v_row.external_id), 'ok', left(v_row.title, 500));
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function private.dropship_source_item(uuid) from public, anon, authenticated;
revoke execute on function private.link_available(uuid) from public, anon, authenticated;
revoke execute on function private.enqueue_dropship_stock_sync() from public, anon, authenticated;
revoke execute on function private.publishable_connection(uuid, uuid) from public, anon, authenticated;

grant execute on function public.save_channel_listing(uuid, uuid, uuid, uuid, text, text, bigint) to authenticated;
grant execute on function public.duplicate_channel_listing(uuid, uuid) to authenticated;
grant execute on function public.delete_channel_listing(uuid) to authenticated;
grant execute on function public.channel_listing_begin(uuid, text) to authenticated;

grant execute on function public.channel_listing_step(uuid, uuid, text, text, text) to service_role;
grant execute on function public.channel_listing_finish(uuid, uuid, boolean, text, text, text, jsonb) to service_role;
