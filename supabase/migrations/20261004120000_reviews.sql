-- =====================================================================
-- Fase 28 · Avaliações e reputação
--
--  * Só avalia quem comprou/recebeu de verdade:
--    - comprador do checkout avalia a loja (e o produto) pelo link de
--      acompanhamento, depois que o pedido foi enviado ou entregue;
--    - vendedor avalia o fornecedor por pedido de fornecimento enviado.
--    Uma avaliação por pedido. Nota 1–5 e comentário opcional.
--  * A organização avaliada responde uma vez; a equipe pode ocultar
--    (com motivo, auditado). Oculta não entra na média.
--  * Métricas objetivas (90 dias), calculadas dos pedidos: fornecedor —
--    taxa de envio, cancelamento e tempo médio até o envio; vendedor —
--    taxa de entrega e de cancelamento das vendas pagas pelo checkout.
-- =====================================================================

create type public.review_source as enum ('buyer', 'seller');

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  target_org_id uuid not null references public.organizations (id) on delete cascade,
  source public.review_source not null,
  -- buyer: pedido do checkout; seller: pedido de fornecimento.
  order_id uuid unique references public.orders (id) on delete set null,
  supplier_order_id uuid unique references public.supplier_orders (id) on delete set null,
  product_id uuid references public.products (id) on delete set null,
  reviewer_org_id uuid references public.organizations (id) on delete set null,
  -- Como aparece: primeiro nome do comprador ou "Vendedor verificado".
  reviewer_label text not null check (char_length(reviewer_label) between 1 and 60),
  rating smallint not null check (rating between 1 and 5),
  comment text check (comment is null or (comment = btrim(comment) and char_length(comment) between 1 and 1000)),
  reply text check (reply is null or (reply = btrim(reply) and char_length(reply) between 1 and 1000)),
  replied_at timestamptz,
  hidden_at timestamptz,
  hidden_reason text check (hidden_reason is null or char_length(hidden_reason) between 3 and 300),
  created_at timestamptz not null default now(),
  check ((hidden_at is null) = (hidden_reason is null))
);

create index reviews_target_idx on public.reviews (target_org_id, created_at desc);

revoke all on table public.reviews from anon, authenticated;
alter table public.reviews enable row level security;
-- Leitura só pelas RPCs (que escondem ocultas e dados de quem avaliou).

-- ---------------------------------------------------------------------
-- Métricas e resumo
-- ---------------------------------------------------------------------

/** Reputação de uma organização (sem checagem de acesso: o chamador valida). */
create function private.org_reputation(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind public.org_kind := (select o.kind from public.organizations o where o.id = p_org);
  v_since timestamptz := now() - interval '90 days';
  v_metrics jsonb;
begin
  if v_kind = 'supplier' then
    select jsonb_build_object(
      'orders', count(*),
      'shipped', count(*) filter (where so.status = 'shipped'),
      'cancelled', count(*) filter (where so.status = 'cancelled'),
      'avg_ship_hours', round(avg(extract(epoch from so.shipped_at - so.created_at) / 3600)
        filter (where so.status = 'shipped'))::integer
    ) into v_metrics
    from public.supplier_orders so
    where so.organization_id = p_org and so.created_at >= v_since
      -- Pendentes recentes ainda estão no prazo: não contam.
      and not (so.status = 'pending' and so.created_at > now() - interval '3 days');
  else
    select jsonb_build_object(
      'orders', count(*),
      'delivered', count(*) filter (where o.status = 'delivered'),
      'shipped', count(*) filter (where o.status in ('shipped', 'delivered')),
      'cancelled', count(*) filter (where o.status = 'cancelled')
    ) into v_metrics
    from public.orders o
    join public.checkout_payments c on c.order_id = o.id
    where o.organization_id = p_org and o.created_at >= v_since and c.approved_at is not null;
  end if;

  return jsonb_build_object(
    'kind', v_kind,
    'metrics', v_metrics,
    'rating_avg', (select round(avg(r.rating), 1) from public.reviews r
                   where r.target_org_id = p_org and r.hidden_at is null),
    'rating_count', (select count(*) from public.reviews r
                     where r.target_org_id = p_org and r.hidden_at is null),
    'distribution', (
      select jsonb_object_agg(s.n, coalesce((
        select count(*) from public.reviews r
        where r.target_org_id = p_org and r.hidden_at is null and r.rating = s.n), 0))
      from generate_series(1, 5) s(n)
    )
  );
end;
$$;

/** Avaliações visíveis (mais recentes). */
create function private.org_reviews(p_org uuid, p_limit integer, p_offset integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(x.item order by x.created_at desc), '[]'::jsonb)
  from (
    select r.created_at, jsonb_build_object(
      'id', r.id,
      'source', r.source,
      'reviewer_label', r.reviewer_label,
      'product_name', (select p.name from public.products p where p.id = r.product_id),
      'rating', r.rating,
      'comment', r.comment,
      'reply', r.reply,
      'replied_at', r.replied_at,
      'created_at', r.created_at
    ) as item
    from public.reviews r
    where r.target_org_id = p_org and r.hidden_at is null
    order by r.created_at desc
    limit least(greatest(coalesce(p_limit, 20), 1), 50)
    offset greatest(coalesce(p_offset, 0), 0)
  ) x
$$;

/**
 * Reputação e avaliações de uma organização para contas conectadas:
 * a própria (membros), fornecedores ativos (vendedores escolhendo
 * produtos) e a equipe.
 */
create function public.organization_reputation(p_org uuid, p_limit integer, p_offset integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (
    private.is_org_member(p_org) or private.is_platform_admin() or exists (
      select 1 from public.organizations o
      where o.id = p_org and o.kind = 'supplier' and o.suspended_at is null
        and o.approval_status = 'approved'
    )
  ) then
    raise exception 'reviews.not_found';
  end if;
  return private.org_reputation(p_org) || jsonb_build_object(
    'name', (select o.name from public.organizations o where o.id = p_org),
    'can_reply', private.has_org_role(p_org, '{owner,admin}'),
    'reviews', private.org_reviews(p_org, p_limit, p_offset)
  );
end;
$$;

/** Reputação do fornecedor de um anúncio visível no catálogo (vendedores escolhendo). */
create function public.listing_supplier_reputation(p_listing uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if not private.visible_listing(p_listing) then
    raise exception 'reviews.not_found';
  end if;
  select l.organization_id into v_org from public.catalog_listings l where l.id = p_listing;
  return private.org_reputation(v_org) || jsonb_build_object(
    'name', (select o.name from public.organizations o where o.id = v_org),
    'can_reply', false,
    'reviews', private.org_reviews(v_org, 5, 0)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Avaliar
-- ---------------------------------------------------------------------

/** Primeiro nome para exibir (sem sobrenome, e-mail ou documento). */
create function private.first_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(nullif(left(split_part(btrim(coalesce(p_name, '')), ' ', 1), 40), ''), 'Comprador')
$$;

/** O comprador do checkout pode avaliar o pedido (pago, não estornado, enviado ou entregue)? */
create function private.checkout_review_allowed(p_order uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.orders o
    join public.checkout_payments c on c.order_id = o.id
    where o.id = p_order and c.settled_at is not null and c.reversed_at is null
      and (o.status in ('shipped', 'delivered') or exists (
        select 1 from public.supplier_orders so where so.order_id = o.id and so.status = 'shipped'))
  ) and not exists (select 1 from public.reviews r where r.order_id = p_order)
$$;

/** Avaliação do comprador (Edge Function, service role), pelo token do acompanhamento. */
create function public.checkout_submit_review(p_token uuid, p_rating integer, p_comment text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
begin
  select o.* into v_order from public.checkout_payments c
  join public.orders o on o.id = c.order_id
  where c.public_token = p_token
  for update of o;
  if v_order.id is null then
    raise exception 'reviews.not_found';
  end if;
  if p_rating is null or p_rating not between 1 and 5 or char_length(coalesce(v_comment, '')) > 1000 then
    raise exception 'reviews.invalid';
  end if;
  if exists (select 1 from public.reviews r where r.order_id = v_order.id) then
    raise exception 'reviews.already_reviewed';
  end if;
  if not private.checkout_review_allowed(v_order.id) then
    raise exception 'reviews.not_allowed';
  end if;

  insert into public.reviews (target_org_id, source, order_id, product_id, reviewer_label, rating, comment)
  values (
    v_order.organization_id, 'buyer', v_order.id,
    (select i.product_id from public.order_items oi
     join public.inventory_items i on i.id = oi.inventory_item_id
     where oi.order_id = v_order.id limit 1),
    private.first_name(v_order.customer_name), p_rating, v_comment
  );
end;
$$;

/** O vendedor avalia o fornecedor por um pedido de fornecimento enviado (owner/admin). */
create function public.review_supplier_order(p_supplier_order uuid, p_rating integer, p_comment text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_so public.supplier_orders%rowtype;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_id uuid;
begin
  select * into v_so from public.supplier_orders so where so.id = p_supplier_order for update;
  if v_so.id is null or not private.has_org_role(v_so.seller_organization_id, '{owner,admin}') then
    raise exception 'reviews.not_found';
  end if;
  if p_rating is null or p_rating not between 1 and 5 or char_length(coalesce(v_comment, '')) > 1000 then
    raise exception 'reviews.invalid';
  end if;
  if v_so.status <> 'shipped' then
    raise exception 'reviews.not_allowed';
  end if;
  if exists (select 1 from public.reviews r where r.supplier_order_id = p_supplier_order) then
    raise exception 'reviews.already_reviewed';
  end if;

  insert into public.reviews (
    target_org_id, source, supplier_order_id, product_id, reviewer_org_id, reviewer_label, rating, comment
  ) values (
    v_so.organization_id, 'seller', v_so.id,
    (select i.product_id from public.supplier_order_items soi
     join public.inventory_items i on i.id = soi.inventory_item_id
     where soi.supplier_order_id = v_so.id limit 1),
    v_so.seller_organization_id, 'Vendedor verificado', p_rating, v_comment
  )
  returning id into v_id;
  return v_id;
end;
$$;

/** Avaliações que o vendedor fez nos pedidos de fornecimento de um pedido. */
create function public.my_supplier_reviews(p_order uuid)
returns table (supplier_order_id uuid, rating smallint, comment text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.orders o where o.id = p_order and private.has_org_role(o.organization_id, '{owner,admin}')
  ) then
    raise exception 'reviews.not_found';
  end if;
  return query
    select r.supplier_order_id, r.rating, r.comment
    from public.reviews r
    join public.supplier_orders so on so.id = r.supplier_order_id
    where so.order_id = p_order;
end;
$$;

/** Resposta da organização avaliada (uma vez; owner/admin). */
create function public.reply_review(p_review uuid, p_reply text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_review public.reviews%rowtype;
  v_reply text := btrim(coalesce(p_reply, ''));
begin
  select * into v_review from public.reviews r where r.id = p_review for update;
  if v_review.id is null or not private.has_org_role(v_review.target_org_id, '{owner,admin}') then
    raise exception 'reviews.not_found';
  end if;
  if char_length(v_reply) not between 1 and 1000 then
    raise exception 'reviews.invalid';
  end if;
  if v_review.reply is not null then
    raise exception 'reviews.already_replied';
  end if;
  update public.reviews set reply = v_reply, replied_at = now() where id = p_review;
end;
$$;

-- Aviso para a organização avaliada (Fase 24).
create function private.on_review_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.notify_org(
    new.target_org_id, '{owner,admin}', 'review.new',
    'Nova avaliação: ' || new.rating || ' de 5',
    coalesce(left(new.comment, 200), 'Sem comentário.'),
    '/reputacao'
  );
  return null;
end;
$$;

create trigger reviews_notify
  after insert on public.reviews
  for each row execute function private.on_review_created();

-- ---------------------------------------------------------------------
-- Comprador: acompanhamento do pedido mostra se pode avaliar
-- ---------------------------------------------------------------------
create or replace function public.checkout_order_status(p_token uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'order_number', o.number,
    'store_name', org.name,
    'product_name', (select oi.name from public.order_items oi where oi.order_id = o.id limit 1),
    'total_cents', o.total_cents,
    'payment_status', c.status,
    'order_status', o.status,
    'method', c.method,
    'pix_qr_code', case when c.status = 'pending' then c.pix_qr_code end,
    'pix_qr_base64', case when c.status = 'pending' then c.pix_qr_base64 end,
    'boleto_url', case when c.status = 'pending' then c.boleto_url end,
    'expires_at', c.expires_at,
    'refund_pending', c.needs_refund,
    'tracking', (
      select jsonb_agg(jsonb_build_object('carrier', so.carrier, 'code', so.tracking_code))
      from public.supplier_orders so
      where so.order_id = o.id and so.tracking_code is not null
    ),
    'can_review', private.checkout_review_allowed(o.id),
    'review', (
      select jsonb_build_object('rating', r.rating, 'comment', r.comment, 'reply', r.reply)
      from public.reviews r where r.order_id = o.id
    )
  )
  from public.checkout_payments c
  join public.orders o on o.id = c.order_id
  join public.organizations org on org.id = o.organization_id
  where c.public_token = p_token
$$;

-- Nota da loja na vitrine e no produto (service role, Edge Function).
create function public.store_rating(p_product uuid, p_store_code text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'rating_avg', (select round(avg(r.rating), 1) from public.reviews r
                   where r.target_org_id = o.id and r.hidden_at is null),
    'rating_count', (select count(*) from public.reviews r
                     where r.target_org_id = o.id and r.hidden_at is null)
  )
  from public.organizations o
  where o.kind = 'seller' and (
    o.id = (select p.organization_id from public.products p where p.id = p_product)
    or o.public_code = private.normalize_public_code(p_store_code)
  )
  limit 1
$$;

-- ---------------------------------------------------------------------
-- Equipe
-- ---------------------------------------------------------------------

/** Avaliações para moderação. p_filter: all | hidden | low (1–2 estrelas). */
create function public.admin_reviews(p_filter text, p_limit integer, p_offset integer)
returns table (
  id uuid,
  target_name text,
  target_kind public.org_kind,
  source public.review_source,
  reviewer_label text,
  reviewer_org_name text,
  rating smallint,
  comment text,
  reply text,
  hidden_at timestamptz,
  hidden_reason text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return query
    select r.id, t.name, t.kind, r.source, r.reviewer_label, ro.name, r.rating, r.comment, r.reply,
      r.hidden_at, r.hidden_reason, r.created_at
    from public.reviews r
    join public.organizations t on t.id = r.target_org_id
    left join public.organizations ro on ro.id = r.reviewer_org_id
    where case coalesce(p_filter, 'all')
      when 'hidden' then r.hidden_at is not null
      when 'low' then r.rating <= 2
      else true
    end
    order by r.created_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

create function public.admin_set_review_hidden(p_review uuid, p_hidden boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_review public.reviews%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform private.require_platform_admin();
  select * into v_review from public.reviews r where r.id = p_review for update;
  if v_review.id is null then
    raise exception 'reviews.not_found';
  end if;
  if p_hidden and (v_reason is null or char_length(v_reason) not between 3 and 300) then
    raise exception 'reviews.reason_required';
  end if;
  update public.reviews set
    hidden_at = case when p_hidden then now() end,
    hidden_reason = case when p_hidden then v_reason end
  where id = p_review;
  perform private.audit(
    case when p_hidden then 'review.hide' else 'review.show' end, v_review.target_org_id,
    case when p_hidden then 'Avaliação ocultada' else 'Avaliação reexibida' end,
    jsonb_build_object('review_id', p_review, 'rating', v_review.rating, 'reason', v_reason)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function private.org_reputation(uuid) from public, anon, authenticated;
revoke execute on function private.org_reviews(uuid, integer, integer) from public, anon, authenticated;
revoke execute on function private.first_name(text) from public, anon, authenticated;
revoke execute on function private.checkout_review_allowed(uuid) from public, anon, authenticated;
revoke execute on function private.on_review_created() from public, anon, authenticated;

grant execute on function public.organization_reputation(uuid, integer, integer) to authenticated;
grant execute on function public.listing_supplier_reputation(uuid) to authenticated;
grant execute on function public.review_supplier_order(uuid, integer, text) to authenticated;
grant execute on function public.my_supplier_reviews(uuid) to authenticated;
grant execute on function public.reply_review(uuid, text) to authenticated;
grant execute on function public.admin_reviews(text, integer, integer) to authenticated;
grant execute on function public.admin_set_review_hidden(uuid, boolean, text) to authenticated;

grant execute on function public.checkout_submit_review(uuid, integer, text) to service_role;
grant execute on function public.store_rating(uuid, text) to service_role;
