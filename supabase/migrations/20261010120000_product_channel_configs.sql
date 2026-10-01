-- =====================================================================
-- Fase 34 · Configuração por canal no cadastro do produto
--
--  * Ao cadastrar ou importar um produto, o vendedor deixa pronto o
--    anúncio de cada canal (Mercado Livre, Shopee, TikTok Shop): título,
--    preço, tipo de anúncio, categoria e frete. Uma linha por produto e
--    canal; "vender neste canal" liga/desliga sem perder o que foi
--    preenchido.
--  * Só vendedor (o fornecedor cadastra apenas o produto base).
--  * O tipo de anúncio precisa ter taxa ativa cadastrada pela equipe (a
--    mesma regra das ferramentas de preço), para o lucro estimado ser real.
--  * Limite de título por canal (Mercado Livre 60, Shopee 120, TikTok Shop
--    255). A categoria do marketplace é o código do canal (ex.: MLB1234 no
--    Mercado Livre); a categoria da plataforma vale para a taxa.
--  * Publicar no canal a partir desta configuração ainda não: depende da
--    API de cada marketplace (próximas fases).
-- =====================================================================

create table public.product_channel_configs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  provider public.marketplace_provider not null
    check (provider in ('mercadolivre', 'shopee', 'tiktok')),
  enabled boolean not null default true,
  title text not null check (char_length(title) between 1 and 255),
  price_cents bigint not null check (price_cents between 1 and 100000000000),
  listing_type text not null check (listing_type ~ '^[a-z0-9_-]{1,40}$'),
  category_id uuid references public.categories (id) on delete set null,
  marketplace_category text check (marketplace_category is null or marketplace_category ~ '^[A-Za-z0-9_-]{1,60}$'),
  free_shipping boolean not null default false,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, provider)
);

create index product_channel_configs_org_idx on public.product_channel_configs (organization_id);

create trigger product_channel_configs_set_updated_at
  before update on public.product_channel_configs
  for each row execute function public.set_updated_at();

revoke all on table public.product_channel_configs from anon, authenticated;
grant select on table public.product_channel_configs to authenticated;
alter table public.product_channel_configs enable row level security;

create policy "product_channel_configs: membros do vendedor leem"
  on public.product_channel_configs for select to authenticated
  using (private.is_org_member(organization_id));

/** Limite de título de cada canal. */
create function private.channel_title_limit(p_provider public.marketplace_provider)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_provider when 'mercadolivre' then 60 when 'shopee' then 120 else 255 end
$$;

/**
 * Cria ou atualiza a configuração de um canal do produto (owner/admin do
 * vendedor). Erros: products.not_found, channels.sellers_only,
 * channels.invalid, channels.title_too_long, channels.listing_type_unavailable.
 */
create function public.save_product_channel_config(
  p_product uuid,
  p_provider public.marketplace_provider,
  p_enabled boolean,
  p_title text,
  p_price_cents bigint,
  p_listing_type text,
  p_category uuid,
  p_marketplace_category text,
  p_free_shipping boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_title text := btrim(coalesce(p_title, ''));
  v_type text := lower(btrim(coalesce(p_listing_type, '')));
  v_mcat text := nullif(upper(btrim(coalesce(p_marketplace_category, ''))), '');
  v_id uuid;
begin
  select p.organization_id into v_org from public.products p where p.id = p_product;
  if v_org is null or not private.has_org_role(v_org, '{owner,admin}') then
    raise exception 'products.not_found';
  end if;
  if private.org_kind(v_org) <> 'seller' then
    raise exception 'channels.sellers_only' using errcode = '42501';
  end if;
  if p_provider is null or p_provider not in ('mercadolivre', 'shopee', 'tiktok')
     or p_enabled is null or p_free_shipping is null or v_title = ''
     or p_price_cents is null or p_price_cents not between 1 and 100000000000 then
    raise exception 'channels.invalid';
  end if;
  if char_length(v_title) > private.channel_title_limit(p_provider) then
    raise exception 'channels.title_too_long';
  end if;
  if not exists (
    select 1 from public.marketplace_fee_rules r
    where r.provider = p_provider and r.listing_type = v_type and r.is_active
  ) then
    raise exception 'channels.listing_type_unavailable';
  end if;
  if p_category is not null and not exists (
    select 1 from public.categories c where c.id = p_category and c.is_active
  ) then
    raise exception 'channels.invalid';
  end if;

  insert into public.product_channel_configs as t (
    organization_id, product_id, provider, enabled, title, price_cents, listing_type,
    category_id, marketplace_category, free_shipping, updated_by
  ) values (
    v_org, p_product, p_provider, p_enabled, v_title, p_price_cents, v_type,
    p_category, v_mcat, p_free_shipping, auth.uid()
  )
  on conflict (product_id, provider) do update set
    enabled = excluded.enabled,
    title = excluded.title,
    price_cents = excluded.price_cents,
    listing_type = excluded.listing_type,
    category_id = excluded.category_id,
    marketplace_category = excluded.marketplace_category,
    free_shipping = excluded.free_shipping,
    updated_by = excluded.updated_by
  returning t.id into v_id;
  return v_id;
end;
$$;

revoke execute on function private.channel_title_limit(public.marketplace_provider) from public, anon, authenticated;
revoke execute on function public.save_product_channel_config(uuid, public.marketplace_provider, boolean, text, bigint, text, uuid, text, boolean) from public, anon;
grant execute on function public.save_product_channel_config(uuid, public.marketplace_provider, boolean, text, bigint, text, uuid, text, boolean) to authenticated;
