-- =====================================================================
-- Fase 22 · Carteira e saques
--
-- A carteira é uma visão do livro-razão: só o dinheiro que a plataforma
-- recebeu em nome da organização (checkout) e ainda não repassou.
-- Recebimentos manuais e acertos diretos vendedor ↔ fornecedor (Fase 9)
-- não passam pela plataforma e ficam fora da carteira.
--
--  * Pendente: créditos do checkout de pedidos ainda no prazo de garantia.
--    O pedido libera no que vier primeiro: entrega + N dias ou envio do
--    fornecedor + M dias (N, M editáveis pela equipe em `wallet_settings`).
--    Estorno/contestação entra no mesmo pedido e se compensa com ele.
--  * Bloqueado: saques solicitados ou aprovados e ainda não pagos.
--  * Disponível: liberado − sacado − bloqueado. Pode ficar negativo se um
--    estorno chegar depois do saque; créditos futuros cobrem a diferença.
--  * Saque: o proprietário solicita para uma chave PIX; a equipe aprova,
--    paga pelo Mercado Pago (painel da conta da plataforma) e registra o
--    identificador da transferência. Só então entra o débito no razão.
--    O repasse automático pela API não é feito aqui (depende de liberação
--    da conta no Mercado Pago).
-- =====================================================================

alter type public.ledger_kind add value if not exists 'withdrawal';

create type public.withdrawal_status as enum ('requested', 'approved', 'paid', 'rejected', 'cancelled');
create type public.pix_key_type as enum ('cpf', 'cnpj', 'email', 'phone', 'random');

-- Sinal do novo tipo (comparação por texto: enum recém-alterado).
alter table public.ledger_entries drop constraint ledger_entries_kind_sign;
alter table public.ledger_entries add constraint ledger_entries_kind_sign check (
  (kind::text in ('sale_payment', 'supplier_receipt', 'checkout_commission', 'checkout_supplier')
    and amount_cents > 0)
  or (kind::text in ('refund', 'supplier_payment', 'checkout_reversal', 'withdrawal') and amount_cents < 0)
);

create index ledger_entries_order_idx on public.ledger_entries (order_id) where order_id is not null;

-- ---------------------------------------------------------------------
-- Regras da carteira (linha única, editável pela equipe)
-- ---------------------------------------------------------------------
create table public.wallet_settings (
  id boolean primary key default true check (id),
  release_days_after_delivery integer not null check (release_days_after_delivery between 0 and 90),
  release_days_after_shipping integer not null check (release_days_after_shipping between 1 and 180),
  min_withdrawal_cents bigint not null check (min_withdrawal_cents between 100 and 100000000),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

-- Valores iniciais; a equipe ajusta em Administração → Saques.
insert into public.wallet_settings (release_days_after_delivery, release_days_after_shipping, min_withdrawal_cents)
values (7, 30, 1000);

-- ---------------------------------------------------------------------
-- Chave PIX
-- ---------------------------------------------------------------------

/** Chave PIX já normalizada (dígitos, e-mail minúsculo, aleatória minúscula). */
create function private.is_valid_pix_key(p_type public.pix_key_type, p_key text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(case p_type
    when 'cpf' then p_key ~ '^[0-9]{11}$' and private.is_valid_document(p_key)
    when 'cnpj' then p_key ~ '^[0-9]{14}$' and private.is_valid_document(p_key)
    when 'phone' then private.is_valid_phone(p_key)
    when 'email' then char_length(p_key) <= 77 and p_key ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
    when 'random' then p_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  end, false)
$$;

create function private.normalize_pix_key(p_type public.pix_key_type, p_key text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_type in ('cpf', 'cnpj', 'phone') then regexp_replace(coalesce(p_key, ''), '[^0-9]', '', 'g')
    else lower(btrim(coalesce(p_key, '')))
  end
$$;

-- ---------------------------------------------------------------------
-- Solicitações de saque
-- ---------------------------------------------------------------------
create table public.withdrawal_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  amount_cents bigint not null check (amount_cents between 1 and 100000000000),
  status public.withdrawal_status not null default 'requested',
  pix_key_type public.pix_key_type not null,
  pix_key text not null check (private.is_valid_pix_key(pix_key_type, pix_key)),
  holder_name text not null check (char_length(holder_name) between 2 and 120),
  holder_document text not null check (private.is_valid_document(holder_document)),
  request_id uuid not null,
  -- Sem FK para usuário: o registro sobrevive à exclusão da conta.
  requested_by uuid,
  decided_by uuid,
  decided_at timestamptz,
  rejection_reason text check (rejection_reason is null or char_length(rejection_reason) between 3 and 500),
  paid_by uuid,
  paid_at timestamptz,
  payout_reference text check (payout_reference is null or char_length(payout_reference) between 3 and 120),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, request_id),
  check ((status = 'paid') = (paid_at is not null and payout_reference is not null)),
  check ((status = 'rejected') = (rejection_reason is not null))
);

create index withdrawal_requests_org_idx on public.withdrawal_requests (organization_id, created_at desc);
create index withdrawal_requests_open_idx on public.withdrawal_requests (status, created_at)
  where status in ('requested', 'approved');

create trigger withdrawal_requests_set_updated_at
  before update on public.withdrawal_requests
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Privilégios e RLS
-- ---------------------------------------------------------------------
revoke all on table public.wallet_settings from anon, authenticated;
revoke all on table public.withdrawal_requests from anon, authenticated;
grant select on table public.wallet_settings to authenticated;
grant select on table public.withdrawal_requests to authenticated;

alter table public.wallet_settings enable row level security;
alter table public.withdrawal_requests enable row level security;

create policy "wallet_settings: contas conectadas leem"
  on public.wallet_settings for select to authenticated
  using (true);

create policy "withdrawal_requests: owner/admin leem"
  on public.withdrawal_requests for select to authenticated
  using (private.has_org_role(organization_id, '{owner,admin}'));

-- ---------------------------------------------------------------------
-- Saldo
-- ---------------------------------------------------------------------

/** Quando os créditos do checkout de um pedido ficam disponíveis (nulo = ainda não). */
create function private.order_release_at(p_order uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select least(
    o.delivered_at + make_interval(days => s.release_days_after_delivery),
    (select max(so.shipped_at) from public.supplier_orders so where so.order_id = o.id)
      + make_interval(days => s.release_days_after_shipping)
  )
  from public.orders o
  cross join public.wallet_settings s
  where o.id = p_order
$$;

/** Saldos da carteira, sem checagem de papel (o chamador valida). */
create function private.wallet_balance(p_org uuid)
returns table (
  available_cents bigint,
  pending_cents bigint,
  blocked_cents bigint,
  withdrawn_cents bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with by_order as (
    select e.order_id, sum(e.amount_cents) as amount, private.order_release_at(e.order_id) as release_at
    from public.ledger_entries e
    where e.organization_id = p_org
      and e.kind::text in ('checkout_commission', 'checkout_supplier', 'checkout_reversal')
    group by e.order_id
  ),
  totals as (
    select
      coalesce(sum(b.amount) filter (where b.release_at <= now()), 0) as released,
      coalesce(sum(b.amount) filter (where b.release_at is null or b.release_at > now()), 0) as pending
    from by_order b
  ),
  withdrawn as (
    select coalesce(-sum(e.amount_cents), 0) as amount
    from public.ledger_entries e
    where e.organization_id = p_org and e.kind::text = 'withdrawal'
  ),
  blocked as (
    select coalesce(sum(w.amount_cents), 0) as amount
    from public.withdrawal_requests w
    where w.organization_id = p_org and w.status in ('requested', 'approved')
  )
  select
    (t.released - wd.amount - bl.amount)::bigint,
    t.pending::bigint,
    bl.amount::bigint,
    wd.amount::bigint
  from totals t, withdrawn wd, blocked bl
$$;

/** Resumo da carteira (owner/admin). */
create function public.wallet_summary(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b record;
  s public.wallet_settings%rowtype;
begin
  if not private.has_org_role(p_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  select * into b from private.wallet_balance(p_org);
  select * into s from public.wallet_settings;
  return jsonb_build_object(
    'available_cents', b.available_cents,
    'pending_cents', b.pending_cents,
    'blocked_cents', b.blocked_cents,
    'withdrawn_cents', b.withdrawn_cents,
    'min_withdrawal_cents', s.min_withdrawal_cents,
    'release_days_after_delivery', s.release_days_after_delivery,
    'release_days_after_shipping', s.release_days_after_shipping,
    'can_withdraw', private.has_org_role(p_org, '{owner}')
  );
end;
$$;

/** Créditos ainda no prazo de garantia, por pedido (owner/admin). */
create function public.wallet_pending(p_org uuid)
returns table (
  order_id uuid,
  description text,
  amount_cents bigint,
  release_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_org_role(p_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  return query
    select x.order_id, x.description, x.amount, x.release_at, x.created_at
    from (
      select e.order_id,
        (array_agg(e.description order by e.created_at))[1] as description,
        sum(e.amount_cents)::bigint as amount,
        private.order_release_at(e.order_id) as release_at,
        min(e.created_at) as created_at
      from public.ledger_entries e
      where e.organization_id = p_org
        and e.kind::text in ('checkout_commission', 'checkout_supplier', 'checkout_reversal')
      group by e.order_id
    ) x
    where x.amount <> 0 and (x.release_at is null or x.release_at > now())
    order by x.release_at nulls last, x.created_at
    limit 200;
end;
$$;

-- ---------------------------------------------------------------------
-- Organização: solicitar e cancelar saque (só o proprietário)
-- ---------------------------------------------------------------------

create function public.request_withdrawal(
  p_org uuid,
  p_amount_cents bigint,
  p_pix_key_type public.pix_key_type,
  p_pix_key text,
  p_holder_name text,
  p_holder_document text,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_key text := private.normalize_pix_key(p_pix_key_type, p_pix_key);
  v_doc text := regexp_replace(coalesce(p_holder_document, ''), '[^0-9]', '', 'g');
  v_name text := btrim(coalesce(p_holder_name, ''));
  v_available bigint;
begin
  if not private.has_org_role(p_org, '{owner}') then
    raise exception 'wallet.forbidden' using errcode = '42501';
  end if;
  if p_request_id is null or p_amount_cents is null or p_pix_key_type is null then
    raise exception 'wallet.invalid';
  end if;

  -- Um saque por vez por organização: o saldo é conferido sem corrida.
  perform pg_advisory_xact_lock(hashtextextended('wallet:' || p_org::text, 0));

  select w.id into v_id from public.withdrawal_requests w
  where w.organization_id = p_org and w.request_id = p_request_id;
  if found then
    return v_id;
  end if;

  if not private.is_valid_pix_key(p_pix_key_type, v_key) then
    raise exception 'wallet.invalid_pix_key';
  end if;
  if char_length(v_name) not between 2 and 120 or not private.is_valid_document(v_doc) then
    raise exception 'wallet.invalid_holder';
  end if;
  if p_amount_cents < (select s.min_withdrawal_cents from public.wallet_settings s) then
    raise exception 'wallet.below_minimum';
  end if;
  select b.available_cents into v_available from private.wallet_balance(p_org) b;
  if p_amount_cents > v_available then
    raise exception 'wallet.insufficient';
  end if;

  insert into public.withdrawal_requests (
    organization_id, amount_cents, pix_key_type, pix_key, holder_name, holder_document,
    request_id, requested_by
  ) values (
    p_org, p_amount_cents, p_pix_key_type, v_key, v_name, v_doc, p_request_id, auth.uid()
  )
  returning id into v_id;
  return v_id;
end;
$$;

create function public.cancel_withdrawal(p_withdrawal uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_w public.withdrawal_requests%rowtype;
begin
  select * into v_w from public.withdrawal_requests w where w.id = p_withdrawal for update;
  if v_w.id is null or not private.has_org_role(v_w.organization_id, '{owner}') then
    raise exception 'wallet.not_found';
  end if;
  if v_w.status <> 'requested' then
    raise exception 'wallet.invalid_status';
  end if;
  update public.withdrawal_requests set status = 'cancelled', cancelled_at = now()
  where id = p_withdrawal;
end;
$$;

-- ---------------------------------------------------------------------
-- Equipe
-- ---------------------------------------------------------------------

create function public.admin_withdrawals_overview()
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
      'requested_count', count(*) filter (where w.status = 'requested'),
      'requested_cents', coalesce(sum(w.amount_cents) filter (where w.status = 'requested'), 0),
      'approved_count', count(*) filter (where w.status = 'approved'),
      'approved_cents', coalesce(sum(w.amount_cents) filter (where w.status = 'approved'), 0),
      'paid_30d_cents', coalesce(sum(w.amount_cents)
        filter (where w.status = 'paid' and w.paid_at > now() - interval '30 days'), 0)
    )
    from public.withdrawal_requests w
  );
end;
$$;

/** Saques, mais antigos primeiro entre os abertos. p_status: open | paid | closed | all. */
create function public.admin_withdrawals(p_status text, p_limit integer, p_offset integer)
returns table (
  id uuid,
  organization_id uuid,
  organization_name text,
  organization_kind public.org_kind,
  organization_suspended boolean,
  amount_cents bigint,
  status public.withdrawal_status,
  pix_key_type public.pix_key_type,
  pix_key text,
  holder_name text,
  holder_document text,
  available_cents bigint,
  rejection_reason text,
  payout_reference text,
  created_at timestamptz,
  decided_at timestamptz,
  paid_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return query
    select w.id, w.organization_id, o.name, o.kind, o.suspended_at is not null, w.amount_cents,
      w.status, w.pix_key_type, w.pix_key, w.holder_name, w.holder_document,
      (select b.available_cents from private.wallet_balance(w.organization_id) b),
      w.rejection_reason, w.payout_reference, w.created_at, w.decided_at, w.paid_at
    from public.withdrawal_requests w
    join public.organizations o on o.id = w.organization_id
    where case coalesce(p_status, 'open')
      when 'open' then w.status in ('requested', 'approved')
      when 'paid' then w.status = 'paid'
      when 'closed' then w.status in ('rejected', 'cancelled')
      else true
    end
    order by case when w.status in ('requested', 'approved') then w.created_at end asc nulls last,
      w.created_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

/** Aprova um saque solicitado: o saldo liberado ainda precisa cobri-lo. */
create function public.admin_approve_withdrawal(p_withdrawal uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_w public.withdrawal_requests%rowtype;
  v_available bigint;
begin
  perform private.require_platform_admin();
  select * into v_w from public.withdrawal_requests w where w.id = p_withdrawal;
  if v_w.id is null then
    raise exception 'wallet.not_found';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('wallet:' || v_w.organization_id::text, 0));
  select * into v_w from public.withdrawal_requests w where w.id = p_withdrawal for update;
  if v_w.status <> 'requested' then
    raise exception 'wallet.invalid_status';
  end if;
  if exists (
    select 1 from public.organizations o where o.id = v_w.organization_id and o.suspended_at is not null
  ) then
    raise exception 'wallet.organization_suspended';
  end if;
  -- O disponível já desconta este saque (bloqueado): basta não ficar negativo.
  select b.available_cents into v_available from private.wallet_balance(v_w.organization_id) b;
  if v_available < 0 then
    raise exception 'wallet.insufficient';
  end if;

  update public.withdrawal_requests
  set status = 'approved', decided_by = auth.uid(), decided_at = now()
  where id = p_withdrawal;
  perform private.audit(
    'wallet.approve', v_w.organization_id, 'Saque aprovado',
    jsonb_build_object('withdrawal_id', p_withdrawal, 'amount_cents', v_w.amount_cents)
  );
end;
$$;

create function public.admin_reject_withdrawal(p_withdrawal uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_w public.withdrawal_requests%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_platform_admin();
  if char_length(v_reason) not between 3 and 500 then
    raise exception 'wallet.reason_required';
  end if;
  select * into v_w from public.withdrawal_requests w where w.id = p_withdrawal for update;
  if v_w.id is null then
    raise exception 'wallet.not_found';
  end if;
  if v_w.status not in ('requested', 'approved') then
    raise exception 'wallet.invalid_status';
  end if;

  update public.withdrawal_requests
  set status = 'rejected', rejection_reason = v_reason, decided_by = auth.uid(), decided_at = now()
  where id = p_withdrawal;
  perform private.audit(
    'wallet.reject', v_w.organization_id, 'Saque recusado',
    jsonb_build_object('withdrawal_id', p_withdrawal, 'amount_cents', v_w.amount_cents, 'reason', v_reason)
  );
end;
$$;

/**
 * Registra o pagamento de um saque aprovado, feito no Mercado Pago:
 * débito no livro-razão da organização. O identificador da transferência
 * (ex.: id da operação ou E2E do PIX) fica guardado para conciliação.
 */
create function public.admin_pay_withdrawal(p_withdrawal uuid, p_reference text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_w public.withdrawal_requests%rowtype;
  v_ref text := btrim(coalesce(p_reference, ''));
begin
  perform private.require_platform_admin();
  if char_length(v_ref) not between 3 and 120 then
    raise exception 'wallet.reference_required';
  end if;
  select * into v_w from public.withdrawal_requests w where w.id = p_withdrawal for update;
  if v_w.id is null then
    raise exception 'wallet.not_found';
  end if;
  if v_w.status <> 'approved' then
    raise exception 'wallet.invalid_status';
  end if;

  insert into public.ledger_entries (organization_id, kind, amount_cents, description, created_by, request_id)
  values (v_w.organization_id, 'withdrawal', -v_w.amount_cents,
    'Saque via PIX — Mercado Pago ' || v_ref, auth.uid(), v_w.id);

  update public.withdrawal_requests
  set status = 'paid', paid_by = auth.uid(), paid_at = now(), payout_reference = v_ref
  where id = p_withdrawal;
  perform private.audit(
    'wallet.pay', v_w.organization_id, 'Saque pago',
    jsonb_build_object('withdrawal_id', p_withdrawal, 'amount_cents', v_w.amount_cents, 'reference', v_ref)
  );
end;
$$;

create function public.admin_save_wallet_settings(
  p_release_days_after_delivery integer,
  p_release_days_after_shipping integer,
  p_min_withdrawal_cents bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  update public.wallet_settings set
    release_days_after_delivery = p_release_days_after_delivery,
    release_days_after_shipping = p_release_days_after_shipping,
    min_withdrawal_cents = p_min_withdrawal_cents,
    updated_by = auth.uid(),
    updated_at = now();
  perform private.audit(
    'wallet.settings', null, 'Regras da carteira alteradas',
    jsonb_build_object(
      'release_days_after_delivery', p_release_days_after_delivery,
      'release_days_after_shipping', p_release_days_after_shipping,
      'min_withdrawal_cents', p_min_withdrawal_cents
    )
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function private.is_valid_pix_key(public.pix_key_type, text) from public, anon, authenticated;
revoke execute on function private.normalize_pix_key(public.pix_key_type, text) from public, anon, authenticated;
revoke execute on function private.order_release_at(uuid) from public, anon, authenticated;
revoke execute on function private.wallet_balance(uuid) from public, anon, authenticated;

grant execute on function public.wallet_summary(uuid) to authenticated;
grant execute on function public.wallet_pending(uuid) to authenticated;
grant execute on function public.request_withdrawal(uuid, bigint, public.pix_key_type, text, text, text, uuid) to authenticated;
grant execute on function public.cancel_withdrawal(uuid) to authenticated;
grant execute on function public.admin_withdrawals_overview() to authenticated;
grant execute on function public.admin_withdrawals(text, integer, integer) to authenticated;
grant execute on function public.admin_approve_withdrawal(uuid) to authenticated;
grant execute on function public.admin_reject_withdrawal(uuid, text) to authenticated;
grant execute on function public.admin_pay_withdrawal(uuid, text) to authenticated;
grant execute on function public.admin_save_wallet_settings(integer, integer, bigint) to authenticated;
