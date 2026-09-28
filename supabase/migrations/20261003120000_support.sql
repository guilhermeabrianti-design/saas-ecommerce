-- =====================================================================
-- Fase 27 · Suporte e denúncias
--
--  * Chamado (ticket) por categoria, aberto por uma conta conectada, com
--    conversa pessoa ↔ equipe. Pode citar um pedido da organização ou
--    denunciar um anúncio do catálogo / uma organização (pelo código
--    público).
--  * Quem abriu vê o chamado; a equipe (aal2) vê todos. Mensagens são
--    imutáveis. Escrita só por RPC.
--  * Estado: open (com a equipe) → waiting_user (equipe respondeu) →
--    closed. Resposta de quem abriu reabre.
--  * Cada lado é avisado pela central de notificações (Fase 24).
-- =====================================================================

create type public.ticket_category as enum ('order', 'payment', 'product', 'account', 'report', 'other');
create type public.ticket_status as enum ('open', 'waiting_user', 'closed');

create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,
  created_by uuid not null references auth.users (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete set null,
  category public.ticket_category not null,
  subject text not null check (subject = btrim(subject) and char_length(subject) between 3 and 120),
  status public.ticket_status not null default 'open',
  order_id uuid references public.orders (id) on delete set null,
  reported_organization_id uuid references public.organizations (id) on delete set null,
  reported_listing_id uuid references public.catalog_listings (id) on delete set null,
  last_message_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'closed') = (closed_at is not null))
);

create index support_tickets_creator_idx on public.support_tickets (created_by, last_message_at desc);
create index support_tickets_queue_idx on public.support_tickets (status, last_message_at);

create trigger support_tickets_set_updated_at
  before update on public.support_tickets
  for each row execute function public.set_updated_at();

create table public.support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets (id) on delete cascade,
  author_id uuid references auth.users (id) on delete set null,
  from_staff boolean not null,
  body text not null check (body = btrim(body) and char_length(body) between 1 and 5000),
  created_at timestamptz not null default now()
);

create index support_messages_ticket_idx on public.support_messages (ticket_id, created_at);

create trigger support_messages_immutable
  before update or delete on public.support_messages
  for each row execute function private.ledger_entries_immutable();

revoke all on table public.support_tickets from anon, authenticated;
revoke all on table public.support_messages from anon, authenticated;
grant select on table public.support_tickets to authenticated;
grant select on table public.support_messages to authenticated;

alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;

create policy "support_tickets: quem abriu e a equipe leem"
  on public.support_tickets for select to authenticated
  using (created_by = (select auth.uid()) or private.is_platform_admin());

create policy "support_messages: quem abriu e a equipe leem"
  on public.support_messages for select to authenticated
  using (exists (
    select 1 from public.support_tickets t
    where t.id = ticket_id and (t.created_by = (select auth.uid()) or private.is_platform_admin())
  ));

-- Limites de uso (Fase 26).
create trigger support_tickets_rate_limit
  before insert on public.support_tickets
  for each row execute function private.limit_inserts('support_tickets', 'created_by', '10', '86400');

create trigger support_messages_rate_limit
  before insert on public.support_messages
  for each row execute function private.limit_inserts('support_messages', 'author_id', '60', '3600');

-- ---------------------------------------------------------------------
-- Notificação para uma pessoa (Fase 24)
-- ---------------------------------------------------------------------
create function private.notify_user(
  p_user uuid,
  p_org uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_link text
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications (user_id, organization_id, kind, title, body, link)
  values (p_user, p_org, p_kind, left(p_title, 160), left(p_body, 500), p_link)
$$;

-- ---------------------------------------------------------------------
-- Pessoa
-- ---------------------------------------------------------------------

/**
 * Abre um chamado. p_org (opcional): organização de onde a pessoa fala
 * (precisa ser membro). p_order: pedido dessa organização. Denúncia:
 * p_reported_code (código público de uma organização) e/ou p_listing
 * (anúncio visível no catálogo).
 */
create function public.create_support_ticket(
  p_org uuid,
  p_category public.ticket_category,
  p_subject text,
  p_body text,
  p_order uuid,
  p_reported_code text,
  p_listing uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_reported uuid;
  v_id uuid;
  v_number bigint;
  v_subject text := btrim(coalesce(p_subject, ''));
begin
  if v_uid is null then
    raise exception 'support.forbidden' using errcode = '42501';
  end if;
  if p_category is null or char_length(v_subject) not between 3 and 120
     or char_length(btrim(coalesce(p_body, ''))) not between 1 and 5000 then
    raise exception 'support.invalid';
  end if;
  if p_org is not null and not private.is_org_member(p_org) then
    raise exception 'support.forbidden' using errcode = '42501';
  end if;
  -- Pedido da própria organização (venda do vendedor ou fornecimento do fornecedor).
  if p_order is not null and not (p_org is not null and (
    exists (select 1 from public.orders o where o.id = p_order and o.organization_id = p_org)
    or exists (
      select 1 from public.supplier_orders so where so.order_id = p_order and so.organization_id = p_org
    )
  )) then
    raise exception 'support.invalid_order';
  end if;

  if private.normalize_public_code(p_reported_code) is not null then
    select o.id into v_reported from public.organizations o
    where o.public_code = private.normalize_public_code(p_reported_code);
    if v_reported is null then
      raise exception 'support.invalid_reported';
    end if;
  end if;
  if p_listing is not null then
    if not private.visible_listing(p_listing) then
      raise exception 'support.invalid_reported';
    end if;
    v_reported := coalesce(v_reported, (select l.organization_id from public.catalog_listings l where l.id = p_listing));
  end if;
  if p_category = 'report' and v_reported is null then
    raise exception 'support.report_target_required';
  end if;

  insert into public.support_tickets (
    created_by, organization_id, category, subject, order_id, reported_organization_id, reported_listing_id
  ) values (
    v_uid, p_org, p_category, v_subject, p_order, v_reported, p_listing
  )
  returning id, number into v_id, v_number;

  insert into public.support_messages (ticket_id, author_id, from_staff, body)
  values (v_id, v_uid, false, btrim(p_body));

  perform private.notify_staff(
    case when p_category = 'report' then 'staff.report' else 'staff.support' end,
    case when p_category = 'report' then 'Nova denúncia #' else 'Novo chamado #' end || v_number || ': ' || v_subject,
    left(btrim(p_body), 200),
    '/admin/suporte/' || v_id
  );
  return v_id;
end;
$$;

/** Responde um chamado (quem abriu ou a equipe). Resposta de quem abriu reabre. */
create function public.reply_support_ticket(p_ticket uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.support_tickets%rowtype;
  v_staff boolean := private.is_platform_admin();
  v_body text := btrim(coalesce(p_body, ''));
begin
  select * into v_ticket from public.support_tickets t where t.id = p_ticket for update;
  if v_ticket.id is null or (v_ticket.created_by <> auth.uid() and not v_staff) then
    raise exception 'support.not_found';
  end if;
  if char_length(v_body) not between 1 and 5000 then
    raise exception 'support.invalid';
  end if;
  -- Equipe respondendo o próprio chamado conta como quem abriu.
  v_staff := v_staff and v_ticket.created_by <> auth.uid();

  insert into public.support_messages (ticket_id, author_id, from_staff, body)
  values (p_ticket, auth.uid(), v_staff, v_body);

  update public.support_tickets set
    status = case when v_staff then 'waiting_user' else 'open' end::public.ticket_status,
    closed_at = null,
    closed_by = null,
    last_message_at = now()
  where id = p_ticket;

  if v_staff then
    perform private.notify_user(
      v_ticket.created_by, null, 'support.reply',
      'Resposta no chamado #' || v_ticket.number || ': ' || v_ticket.subject,
      left(v_body, 200),
      '/suporte/' || p_ticket
    );
  else
    perform private.notify_staff(
      'staff.support', 'Nova mensagem no chamado #' || v_ticket.number || ': ' || v_ticket.subject,
      left(v_body, 200),
      '/admin/suporte/' || p_ticket
    );
  end if;
end;
$$;

/** Encerra um chamado (quem abriu ou a equipe). */
create function public.close_support_ticket(p_ticket uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.support_tickets%rowtype;
begin
  select * into v_ticket from public.support_tickets t where t.id = p_ticket for update;
  if v_ticket.id is null or (v_ticket.created_by <> auth.uid() and not private.is_platform_admin()) then
    raise exception 'support.not_found';
  end if;
  if v_ticket.status = 'closed' then
    return;
  end if;
  update public.support_tickets set status = 'closed', closed_at = now(), closed_by = auth.uid()
  where id = p_ticket;

  if v_ticket.created_by <> auth.uid() then
    perform private.notify_user(
      v_ticket.created_by, null, 'support.closed',
      'Chamado #' || v_ticket.number || ' encerrado pela equipe',
      'Se ainda precisar de ajuda, responda o chamado para reabrir.',
      '/suporte/' || p_ticket
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Equipe
-- ---------------------------------------------------------------------

create function public.admin_support_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return (
    select jsonb_build_object(
      'open', count(*) filter (where t.status = 'open'),
      'open_reports', count(*) filter (where t.status = 'open' and t.category = 'report'),
      'waiting_user', count(*) filter (where t.status = 'waiting_user'),
      'closed_7d', count(*) filter (where t.status = 'closed' and t.closed_at > now() - interval '7 days')
    )
    from public.support_tickets t
  );
end;
$$;

/** Fila da equipe. p_status: open | waiting_user | closed | all; p_category nulo = todas. */
create function public.admin_support_tickets(
  p_status text,
  p_category public.ticket_category,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  number bigint,
  category public.ticket_category,
  subject text,
  status public.ticket_status,
  requester_name text,
  requester_email text,
  organization_name text,
  reported_name text,
  messages bigint,
  last_from_staff boolean,
  last_message_at timestamptz,
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
    select t.id, t.number, t.category, t.subject, t.status,
      p.full_name, u.email::text, org.name, rep.name,
      (select count(*) from public.support_messages m where m.ticket_id = t.id),
      (select m.from_staff from public.support_messages m where m.ticket_id = t.id
       order by m.created_at desc limit 1),
      t.last_message_at, t.created_at
    from public.support_tickets t
    left join public.profiles p on p.id = t.created_by
    left join auth.users u on u.id = t.created_by
    left join public.organizations org on org.id = t.organization_id
    left join public.organizations rep on rep.id = t.reported_organization_id
    where (coalesce(p_status, 'open') = 'all' or t.status::text = coalesce(p_status, 'open'))
      and (p_category is null or t.category = p_category)
    -- Abertos: mais antigos primeiro (fila); demais: mais recentes.
    order by case when t.status = 'open' then t.last_message_at end asc nulls last,
      t.last_message_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

/** Contexto do chamado para a equipe (quem abriu, organização, pedido, denunciado). */
create function public.admin_support_ticket_context(p_ticket uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return (
    select jsonb_build_object(
      'requester_name', p.full_name,
      'requester_email', u.email,
      'organization_name', org.name,
      'organization_kind', org.kind,
      'order_number', (select o.number from public.orders o where o.id = t.order_id),
      'reported_name', rep.name,
      'reported_kind', rep.kind,
      'reported_suspended', rep.suspended_at is not null,
      'reported_listing_name', (
        select pr.name from public.catalog_listings l join public.products pr on pr.id = l.product_id
        where l.id = t.reported_listing_id)
    )
    from public.support_tickets t
    left join public.profiles p on p.id = t.created_by
    left join auth.users u on u.id = t.created_by
    left join public.organizations org on org.id = t.organization_id
    left join public.organizations rep on rep.id = t.reported_organization_id
    where t.id = p_ticket
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function private.notify_user(uuid, uuid, text, text, text, text) from public, anon, authenticated;

grant execute on function public.create_support_ticket(uuid, public.ticket_category, text, text, uuid, text, uuid) to authenticated;
grant execute on function public.reply_support_ticket(uuid, text) to authenticated;
grant execute on function public.close_support_ticket(uuid) to authenticated;
grant execute on function public.admin_support_overview() to authenticated;
grant execute on function public.admin_support_tickets(text, public.ticket_category, integer, integer) to authenticated;
grant execute on function public.admin_support_ticket_context(uuid) to authenticated;
