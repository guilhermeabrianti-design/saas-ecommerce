-- =====================================================================
-- Fase 24 · Notificações em tempo real e alertas
--
--  * Uma linha por destinatário (`notifications.user_id`): cada pessoa lê e
--    marca como lida só as suas. O navegador recebe as novas pelo Supabase
--    Realtime (a publicação respeita a RLS).
--  * Toda notificação nasce de um fato real registrado no banco (gatilhos
--    nas tabelas de estoque, catálogo, pedidos, pagamentos e saques):
--    nada é gerado pelo navegador.
--  * Alertas de estoque disparam na passagem do limite (não a cada
--    movimento): baixo = disponível ≤ mínimo do item (quando definido, a
--    mesma regra das Análises); esgotado = disponível 0; de volta = saiu
--    do zero (só para quem revende o produto do fornecedor).
--  * Assuntos de dinheiro vão só para owner/admin; estoque e pedidos para
--    todos os membros. Equipe (contas `admin`) recebe as filas que exigem
--    ação: saques, estornos pendentes e fornecedores em análise.
--  * Guardadas por 90 dias.
-- =====================================================================

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Nulo = notificação da equipe da plataforma.
  organization_id uuid references public.organizations (id) on delete cascade,
  kind text not null check (kind ~ '^[a-z_]+\.[a-z_]+$' and char_length(kind) <= 60),
  title text not null check (char_length(title) between 1 and 160),
  body text check (body is null or char_length(body) <= 500),
  -- Caminho interno do app (nunca URL externa).
  link text check (link is null or (link ~ '^/([A-Za-z0-9_-][A-Za-z0-9/_-]*)?$' and char_length(link) <= 300)),
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;
create index notifications_created_idx on public.notifications (created_at);

revoke all on table public.notifications from anon, authenticated;
grant select on table public.notifications to authenticated;

alter table public.notifications enable row level security;

-- Só as próprias; notificação de organização some para quem deixou de ser membro.
create policy "notifications: destinatário lê"
  on public.notifications for select to authenticated
  using (
    user_id = auth.uid()
    and (organization_id is null or private.is_org_member(organization_id))
  );

-- Realtime (existe no Supabase; ausente nos testes locais).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Envio
-- ---------------------------------------------------------------------

/** Notifica os membros da organização com um dos papéis. */
create function private.notify_org(
  p_org uuid,
  p_roles public.org_role[],
  p_kind text,
  p_title text,
  p_body text,
  p_link text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_org is null then
    return;
  end if;
  insert into public.notifications (user_id, organization_id, kind, title, body, link)
  select m.user_id, p_org, p_kind, left(p_title, 160), left(p_body, 500), p_link
  from public.organization_members m
  where m.organization_id = p_org and m.role = any (p_roles);

  -- Retenção: 90 dias.
  delete from public.notifications n
  where n.organization_id = p_org and n.created_at < now() - interval '90 days';
end;
$$;

/** Notifica a equipe da plataforma. */
create function private.notify_staff(p_kind text, p_title text, p_body text, p_link text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.notifications (user_id, organization_id, kind, title, body, link)
  select p.id, null, p_kind, left(p_title, 160), left(p_body, 500), p_link
  from public.profiles p
  where p.role = 'admin';

  delete from public.notifications n
  where n.organization_id is null and n.created_at < now() - interval '90 days';
end;
$$;

/** R$ 1.234,56 (independe da configuração regional do banco). */
create function private.format_brl(p_cents bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'R$ ' || translate(to_char(p_cents / 100.0, 'FM999,999,999,990.00'), ',.', '.,')
$$;

/** Nome do item de estoque para a mensagem: produto (SKU da variação). */
create function private.inventory_label(p_item uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.name || coalesce(' (' || v.sku || ')', '')
  from public.inventory_items i
  join public.products p on p.id = i.product_id
  left join public.product_variants v on v.id = i.variant_id
  where i.id = p_item
$$;

/**
 * Avisa os vendedores que importaram o anúncio (produto do vendedor
 * apontando para ele). `p_money` = só owner/admin.
 */
create function private.notify_listing_importers(
  p_listing uuid,
  p_money boolean,
  p_kind text,
  p_title text,
  p_body text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select p.id, p.organization_id, p.name from public.products p
    where p.source_listing_id = p_listing
    order by p.organization_id, p.id
  loop
    perform private.notify_org(
      r.organization_id,
      case when p_money then '{owner,admin}'::public.org_role[] else '{owner,admin,member}'::public.org_role[] end,
      p_kind, p_title || ': ' || r.name, p_body, '/produtos/' || r.id
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- Estoque
-- ---------------------------------------------------------------------
create function private.on_inventory_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old integer := old.on_hand - old.reserved;
  v_new integer := new.on_hand - new.reserved;
  v_label text;
  v_listing uuid;
  v_kind text;
  v_title text;
begin
  if v_old = v_new and old.min_quantity is not distinct from new.min_quantity then
    return null;
  end if;

  if v_old > 0 and v_new = 0 then
    v_kind := 'stock.out';
    v_title := 'Esgotado';
  elsif v_old = 0 and v_new > 0 then
    v_kind := 'stock.back';
    v_title := 'De volta ao estoque';
  elsif new.min_quantity is not null and v_new <= new.min_quantity
        and not (old.min_quantity is not null and v_old <= old.min_quantity) then
    -- Entrou na faixa de estoque baixo (a mesma regra das Análises).
    v_kind := 'stock.low';
    v_title := 'Estoque baixo';
  else
    return null;
  end if;

  v_label := private.inventory_label(new.id);

  -- Dono do estoque (não avisa "de volta": foi ele quem repôs).
  if v_kind <> 'stock.back' then
    perform private.notify_org(
      new.organization_id, '{owner,admin,member}', v_kind,
      v_title || ': ' || v_label,
      'Disponível agora: ' || v_new || coalesce(' · mínimo ' || new.min_quantity, '') || '.',
      '/estoque/' || new.id
    );
  end if;

  -- Quem revende o produto do fornecedor.
  select l.id into v_listing from public.catalog_listings l where l.product_id = new.product_id;
  if v_listing is not null then
    perform private.notify_listing_importers(
      v_listing, false, v_kind, v_title || ' no fornecedor',
      case v_kind
        when 'stock.out' then 'O fornecedor ficou sem estoque' || coalesce(' da opção ' || (
          select v.sku from public.product_variants v where v.id = new.variant_id), '') ||
          '. Novas vendas pelo checkout ficam indisponíveis até a reposição.'
        when 'stock.low' then 'Restam ' || v_new || ' no fornecedor' || coalesce(' (opção ' || (
          select v.sku from public.product_variants v where v.id = new.variant_id) || ')', '') || '.'
        else 'O fornecedor repôs: ' || v_new || ' disponíveis' || coalesce(' (opção ' || (
          select v.sku from public.product_variants v where v.id = new.variant_id) || ')', '') || '.'
      end
    );
  end if;
  return null;
end;
$$;

create trigger inventory_items_notify
  after update of on_hand, reserved, min_quantity on public.inventory_items
  for each row execute function private.on_inventory_change();

-- ---------------------------------------------------------------------
-- Catálogo: preço, disponibilidade e moderação
-- ---------------------------------------------------------------------

/** Anúncio visível no catálogo, com o estado do anúncio informado (o resto como está). */
create function private.listing_visible_with(p_listing uuid, p_published boolean, p_moderation public.listing_moderation)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_published and p_moderation = 'approved' and exists (
    select 1 from public.catalog_listings l
    join public.products p on p.id = l.product_id
    join public.organizations o on o.id = l.organization_id
    where l.id = p_listing and p.status = 'active'
      and o.suspended_at is null and o.approval_status = 'approved'
  ), false)
$$;

create function private.on_listing_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := (select p.name from public.products p where p.id = new.product_id);
  v_was boolean := private.listing_visible_with(new.id, old.is_published, old.moderation_status);
  v_now boolean := private.listing_visible_with(new.id, new.is_published, new.moderation_status);
begin
  if new.wholesale_price_cents <> old.wholesale_price_cents then
    perform private.notify_listing_importers(
      new.id, true, 'listing.price', 'Preço de atacado alterado',
      'De ' || private.format_brl(old.wholesale_price_cents) ||
      ' para ' || private.format_brl(new.wholesale_price_cents) ||
      '. Confira sua margem e o preço de venda.'
    );
  end if;

  if v_was and not v_now then
    perform private.notify_listing_importers(
      new.id, false, 'listing.unavailable', 'Produto indisponível no fornecedor',
      'O anúncio saiu do catálogo. Vendas pelo checkout ficam pausadas até ele voltar.'
    );
  elsif v_now and not v_was then
    perform private.notify_listing_importers(
      new.id, false, 'listing.available', 'Produto disponível de novo',
      'O anúncio voltou ao catálogo do fornecedor.'
    );
  end if;

  -- Resultado da moderação para o fornecedor.
  if new.moderation_status <> old.moderation_status and new.moderation_status <> 'pending' then
    perform private.notify_org(
      new.organization_id, '{owner,admin,member}', 'listing.moderation',
      case new.moderation_status
        when 'approved' then 'Anúncio aprovado: '
        when 'rejected' then 'Anúncio recusado: '
        else 'Anúncio bloqueado: '
      end || v_name,
      case new.moderation_status
        when 'approved' then 'Já aparece no catálogo para os vendedores (se publicado).'
        else 'Veja o motivo no produto e ajuste antes de reenviar.'
      end,
      '/produtos/' || new.product_id
    );
  end if;
  return null;
end;
$$;

create trigger catalog_listings_notify
  after update of wholesale_price_cents, is_published, moderation_status on public.catalog_listings
  for each row execute function private.on_listing_change();

-- Produto do fornecedor ativado/desativado muda a disponibilidade do anúncio.
create function private.on_supplier_product_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_listing public.catalog_listings%rowtype;
  v_org_ok boolean;
begin
  select * into v_listing from public.catalog_listings l where l.product_id = new.id;
  if v_listing.id is null or not v_listing.is_published or v_listing.moderation_status <> 'approved' then
    return null;
  end if;
  select o.suspended_at is null and o.approval_status = 'approved' into v_org_ok
  from public.organizations o where o.id = new.organization_id;
  if not v_org_ok then
    return null;
  end if;

  if old.status = 'active' and new.status <> 'active' then
    perform private.notify_listing_importers(
      v_listing.id, false, 'listing.unavailable', 'Produto indisponível no fornecedor',
      'O fornecedor desativou o produto. Vendas pelo checkout ficam pausadas até ele voltar.'
    );
  elsif old.status <> 'active' and new.status = 'active' then
    perform private.notify_listing_importers(
      v_listing.id, false, 'listing.available', 'Produto disponível de novo',
      'O fornecedor reativou o produto.'
    );
  end if;
  return null;
end;
$$;

create trigger products_notify_status
  after update of status on public.products
  for each row when (old.status is distinct from new.status)
  execute function private.on_supplier_product_status();

-- ---------------------------------------------------------------------
-- Fornecedor: análise, suspensão
-- ---------------------------------------------------------------------
create function private.on_supplier_org_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_was boolean;
  v_now boolean;
  r record;
begin
  if new.kind <> 'supplier' then
    return null;
  end if;

  if tg_op = 'INSERT' then
    if new.approval_status = 'pending' then
      perform private.notify_staff(
        'staff.supplier_review', 'Fornecedor aguardando análise: ' || new.name, null, '/admin/moderacao'
      );
    end if;
    return null;
  end if;

  if new.approval_status is distinct from old.approval_status then
    if new.approval_status = 'pending' then
      perform private.notify_staff(
        'staff.supplier_review', 'Fornecedor aguardando análise: ' || new.name, null, '/admin/moderacao'
      );
    else
      perform private.notify_org(
        new.id, '{owner,admin,member}', 'supplier.review',
        case when new.approval_status = 'approved' then 'Cadastro de fornecedor aprovado'
             else 'Cadastro de fornecedor recusado' end,
        case when new.approval_status = 'approved' then 'Seus anúncios aprovados já podem aparecer no catálogo.'
             else 'Veja o motivo no início e reenvie para análise.' end,
        '/'
      );
    end if;
  end if;

  -- Fornecedor saiu (ou voltou) do catálogo: avisa quem revende.
  v_was := old.suspended_at is null and old.approval_status = 'approved';
  v_now := new.suspended_at is null and new.approval_status = 'approved';
  if v_was <> v_now then
    for r in
      select l.id from public.catalog_listings l
      join public.products p on p.id = l.product_id
      where l.organization_id = new.id and l.is_published and l.moderation_status = 'approved'
        and p.status = 'active'
      order by l.id
    loop
      if v_was then
        perform private.notify_listing_importers(
          r.id, false, 'listing.unavailable', 'Produto indisponível no fornecedor',
          'O fornecedor está temporariamente fora do catálogo. Vendas pelo checkout ficam pausadas.'
        );
      else
        perform private.notify_listing_importers(
          r.id, false, 'listing.available', 'Produto disponível de novo',
          'O fornecedor voltou ao catálogo.'
        );
      end if;
    end loop;
  end if;
  return null;
end;
$$;

create trigger organizations_notify_supplier
  after insert or update of approval_status, suspended_at on public.organizations
  for each row execute function private.on_supplier_org_change();

-- ---------------------------------------------------------------------
-- Pedidos
-- ---------------------------------------------------------------------
create function private.on_supplier_order_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_number bigint := (select o.number from public.orders o where o.id = new.order_id);
begin
  if tg_op = 'INSERT' then
    perform private.notify_org(
      new.organization_id, '{owner,admin,member}', 'supplier_order.new',
      'Novo pedido de fornecimento #' || new.number,
      'Separe e envie para ' || new.ship_city || '/' || new.ship_state || '.',
      '/fornecimentos/' || new.id
    );
    return null;
  end if;

  if new.status = 'shipped' and old.status <> 'shipped' then
    perform private.notify_org(
      new.seller_organization_id, '{owner,admin,member}', 'order.supplier_shipped',
      'Fornecedor enviou o pedido #' || v_order_number,
      coalesce(new.carrier || ' · ' || new.tracking_code, 'Envio registrado pelo fornecedor.'),
      '/pedidos/' || new.order_id
    );
  elsif new.status = 'cancelled' and old.status <> 'cancelled' then
    perform private.notify_org(
      new.organization_id, '{owner,admin,member}', 'supplier_order.cancelled',
      'Pedido de fornecimento #' || new.number || ' cancelado',
      'Não envie este pedido.',
      '/fornecimentos/' || new.id
    );
  end if;
  return null;
end;
$$;

create trigger supplier_orders_notify
  after insert or update of status on public.supplier_orders
  for each row execute function private.on_supplier_order_change();

create function private.on_external_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_provider text := (select c.name from public.integration_connections c where c.id = new.connection_id);
begin
  select * into v_order from public.orders o where o.id = new.order_id;
  perform private.notify_org(
    new.organization_id, '{owner,admin,member}', 'marketplace.order',
    'Novo pedido #' || v_order.number || ' de ' || coalesce(v_provider, 'marketplace'),
    v_order.customer_name,
    '/pedidos/' || new.order_id
  );
  return null;
end;
$$;

create trigger external_orders_notify
  after insert on public.external_orders
  for each row execute function private.on_external_order();

-- ---------------------------------------------------------------------
-- Checkout
-- ---------------------------------------------------------------------
create function private.on_checkout_payment_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number bigint := (select o.number from public.orders o where o.id = new.order_id);
  v_amount text := private.format_brl(new.amount_cents);
begin
  if new.settled_at is not null and old.settled_at is null then
    perform private.notify_org(
      new.organization_id, '{owner,admin}', 'checkout.paid',
      'Venda paga pelo checkout: pedido #' || v_number,
      v_amount || '. O fornecedor já recebeu o pedido de envio.',
      '/pedidos/' || new.order_id
    );
  end if;
  if new.reversed_at is not null and old.reversed_at is null then
    perform private.notify_org(
      new.organization_id, '{owner,admin}', 'checkout.reversed',
      'Venda estornada: pedido #' || v_number,
      v_amount || ' devolvidos ao comprador. A comissão saiu da carteira.',
      '/pedidos/' || new.order_id
    );
  end if;
  if new.needs_refund and not old.needs_refund then
    perform private.notify_staff(
      'staff.refund_needed', 'Estorno pendente: pedido #' || v_number,
      coalesce(new.refund_reason, 'Pagamento aprovado sem condição de seguir.'),
      '/admin/pagamentos'
    );
  end if;
  return null;
end;
$$;

create trigger checkout_payments_notify
  after update of settled_at, reversed_at, needs_refund on public.checkout_payments
  for each row execute function private.on_checkout_payment_change();

-- ---------------------------------------------------------------------
-- Carteira e indicação
-- ---------------------------------------------------------------------
create function private.on_withdrawal_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_amount text := private.format_brl(new.amount_cents);
begin
  if tg_op = 'INSERT' then
    perform private.notify_staff(
      'staff.withdrawal_requested', 'Saque solicitado: ' || v_amount,
      (select o.name from public.organizations o where o.id = new.organization_id),
      '/admin/saques'
    );
    return null;
  end if;
  if new.status = old.status or new.status not in ('approved', 'paid', 'rejected') then
    return null;
  end if;
  perform private.notify_org(
    new.organization_id, '{owner,admin}', 'wallet.withdrawal',
    case new.status
      when 'approved' then 'Saque aprovado: '
      when 'paid' then 'Saque pago: '
      else 'Saque recusado: '
    end || v_amount,
    case new.status
      when 'approved' then 'A equipe vai fazer o PIX.'
      when 'paid' then 'PIX enviado. Identificador: ' || new.payout_reference
      else 'Motivo: ' || new.rejection_reason
    end,
    '/carteira'
  );
  return null;
end;
$$;

create trigger withdrawal_requests_notify
  after insert or update of status on public.withdrawal_requests
  for each row execute function private.on_withdrawal_change();

create function private.on_referral_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := (select o.name from public.organizations o where o.id = new.referred_org_id);
begin
  if tg_op = 'INSERT' then
    perform private.notify_org(
      new.referrer_org_id, '{owner,admin}', 'referral.new',
      'Nova indicação: ' || v_name,
      'Quando fizer a primeira venda paga pelo checkout, você ganha a recompensa.',
      '/indicacoes'
    );
  elsif new.rewarded_at is not null and old.rewarded_at is null then
    perform private.notify_org(
      new.referrer_org_id, '{owner,admin}', 'referral.rewarded',
      'Recompensa de indicação: ' || private.format_brl(new.reward_cents),
      v_name || ' fez a primeira venda. O valor fica pendente na carteira até a garantia da venda.',
      '/carteira'
    );
  end if;
  return null;
end;
$$;

create trigger organization_referrals_notify
  after insert or update of rewarded_at on public.organization_referrals
  for each row execute function private.on_referral_change();

-- ---------------------------------------------------------------------
-- Leitura
-- ---------------------------------------------------------------------

/** Marca como lidas as notificações indicadas (só as próprias). */
create function public.mark_notifications_read(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'notifications.forbidden' using errcode = '42501';
  end if;
  update public.notifications set read_at = now()
  where user_id = auth.uid() and id = any (coalesce(p_ids, '{}')) and read_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

/** Marca todas como lidas (as da equipe ou de uma organização; nulo = todas). */
create function public.mark_all_notifications_read(p_org uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'notifications.forbidden' using errcode = '42501';
  end if;
  update public.notifications set read_at = now()
  where user_id = auth.uid() and read_at is null
    and (p_org is null or organization_id = p_org);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function private.notify_org(uuid, public.org_role[], text, text, text, text) from public, anon, authenticated;
revoke execute on function private.notify_staff(text, text, text, text) from public, anon, authenticated;
revoke execute on function private.inventory_label(uuid) from public, anon, authenticated;
revoke execute on function private.format_brl(bigint) from public, anon, authenticated;
revoke execute on function private.notify_listing_importers(uuid, boolean, text, text, text) from public, anon, authenticated;
revoke execute on function private.listing_visible_with(uuid, boolean, public.listing_moderation) from public, anon, authenticated;
revoke execute on function private.on_inventory_change() from public, anon, authenticated;
revoke execute on function private.on_listing_change() from public, anon, authenticated;
revoke execute on function private.on_supplier_product_status() from public, anon, authenticated;
revoke execute on function private.on_supplier_org_change() from public, anon, authenticated;
revoke execute on function private.on_supplier_order_change() from public, anon, authenticated;
revoke execute on function private.on_external_order() from public, anon, authenticated;
revoke execute on function private.on_checkout_payment_change() from public, anon, authenticated;
revoke execute on function private.on_withdrawal_change() from public, anon, authenticated;
revoke execute on function private.on_referral_change() from public, anon, authenticated;

grant execute on function public.mark_notifications_read(uuid[]) to authenticated;
grant execute on function public.mark_all_notifications_read(uuid) to authenticated;
