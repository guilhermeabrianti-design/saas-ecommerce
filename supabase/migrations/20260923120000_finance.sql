-- =====================================================================
-- Fase 9 · Financeiro
--
-- Registro manual de recebimentos e estornos do pedido do vendedor e
-- acerto com o fornecedor (dropshipping), tudo num livro-razão imutável
-- por organização. Sem gateway de pagamento: o vendedor informa o que
-- recebeu; integração com meios de pagamento é fase própria.
--
--  * `ledger_entries`: valor com sinal (crédito > 0, débito < 0), nunca
--    alterado nem apagado (nem owner, nem cascata, nem truncate).
--  * `order_payments`: recebimentos/estornos do pedido. O saldo pago fica
--    em `orders.paid_cents`/`refunded_cents` (mantido só pelas RPCs).
--  * Acerto com fornecedor: o vendedor paga o atacado congelado do pedido
--    de fornecimento já enviado; gera débito no livro dele e crédito no do
--    fornecedor, na mesma transação.
--  * Dados financeiros: só owner/admin da organização.
-- =====================================================================

create type public.payment_method as enum ('pix', 'card', 'boleto', 'cash', 'transfer', 'other');
create type public.payment_kind as enum ('payment', 'refund');
create type public.ledger_kind as enum ('sale_payment', 'refund', 'supplier_payment', 'supplier_receipt');

alter table public.orders
  add column paid_cents bigint not null default 0 check (paid_cents >= 0),
  add column refunded_cents bigint not null default 0 check (refunded_cents >= 0),
  add constraint orders_paid_within_total check (
    refunded_cents <= paid_cents and paid_cents - refunded_cents <= total_cents
  );

alter table public.supplier_orders
  add column paid_at timestamptz;

-- ---------------------------------------------------------------------
-- Recebimentos e estornos do pedido
-- ---------------------------------------------------------------------
create table public.order_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  kind public.payment_kind not null,
  method public.payment_method not null,
  amount_cents bigint not null check (amount_cents between 1 and 100000000000),
  note text check (note is null or char_length(note) <= 500),
  request_id uuid not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, request_id)
);

create index order_payments_order_idx on public.order_payments (order_id, created_at);

-- ---------------------------------------------------------------------
-- Livro-razão imutável
-- ---------------------------------------------------------------------
create table public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  kind public.ledger_kind not null,
  amount_cents bigint not null check (amount_cents <> 0 and abs(amount_cents) <= 100000000000),
  order_id uuid,
  supplier_order_id uuid,
  description text check (description is null or char_length(description) <= 500),
  -- Sem FK para usuário: o registro sobrevive à exclusão da conta.
  created_by uuid,
  request_id uuid not null,
  created_at timestamptz not null default now(),
  check (
    (kind in ('sale_payment', 'supplier_receipt') and amount_cents > 0)
    or (kind in ('refund', 'supplier_payment') and amount_cents < 0)
  ),
  unique (organization_id, request_id)
);

create index ledger_entries_org_created_idx on public.ledger_entries (organization_id, created_at desc);

create function private.ledger_entries_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'finance.ledger_immutable';
end;
$$;

create trigger ledger_entries_no_update
  before update or delete on public.ledger_entries
  for each row execute function private.ledger_entries_immutable();

create trigger ledger_entries_no_truncate
  before truncate on public.ledger_entries
  for each statement execute function private.ledger_entries_immutable();

-- ---------------------------------------------------------------------
-- Privilégios e RLS: só leitura, só owner/admin; escrita por RPC.
-- ---------------------------------------------------------------------
revoke all on table public.order_payments from anon, authenticated;
revoke all on table public.ledger_entries from anon, authenticated;
grant select on table public.order_payments to authenticated;
grant select on table public.ledger_entries to authenticated;

alter table public.order_payments enable row level security;
alter table public.ledger_entries enable row level security;

create policy "order_payments: owner/admin leem"
  on public.order_payments for select to authenticated
  using (private.has_org_role(organization_id, '{owner,admin}'));

create policy "ledger_entries: owner/admin leem"
  on public.ledger_entries for select to authenticated
  using (private.has_org_role(organization_id, '{owner,admin}'));

-- ---------------------------------------------------------------------
-- RPCs do vendedor
-- ---------------------------------------------------------------------

/**
 * Registra um recebimento. Pedido cancelado não recebe; o líquido pago
 * (pago − estornado) nunca passa do total. Idempotente por p_request_id.
 */
create function public.record_order_payment(
  p_order uuid,
  p_amount_cents bigint,
  p_method public.payment_method,
  p_note text,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype := private.lock_order_for(p_order, '{owner,admin}');
  v_existing uuid;
  v_id uuid;
begin
  if p_request_id is null or p_amount_cents is null or p_amount_cents < 1 then
    raise exception 'finance.invalid';
  end if;

  select pay.id into v_existing from public.order_payments pay
  where pay.organization_id = v_order.organization_id and pay.request_id = p_request_id;
  if found then
    return v_existing;
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'finance.order_cancelled';
  end if;
  if v_order.paid_cents - v_order.refunded_cents + p_amount_cents > v_order.total_cents then
    raise exception 'finance.overpayment';
  end if;

  insert into public.order_payments (
    organization_id, order_id, kind, method, amount_cents, note, request_id, created_by
  ) values (
    v_order.organization_id, p_order, 'payment', p_method, p_amount_cents,
    nullif(btrim(p_note), ''), p_request_id, auth.uid()
  )
  returning id into v_id;

  insert into public.ledger_entries (
    organization_id, kind, amount_cents, order_id, description, created_by, request_id
  ) values (
    v_order.organization_id, 'sale_payment', p_amount_cents, p_order,
    'Recebimento do pedido #' || v_order.number, auth.uid(), v_id
  );

  update public.orders set paid_cents = paid_cents + p_amount_cents where id = p_order;
  return v_id;
end;
$$;

/** Estorna parte ou todo o líquido já recebido (qualquer situação do pedido). */
create function public.refund_order_payment(
  p_order uuid,
  p_amount_cents bigint,
  p_method public.payment_method,
  p_note text,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype := private.lock_order_for(p_order, '{owner,admin}');
  v_existing uuid;
  v_id uuid;
begin
  if p_request_id is null or p_amount_cents is null or p_amount_cents < 1 then
    raise exception 'finance.invalid';
  end if;

  select pay.id into v_existing from public.order_payments pay
  where pay.organization_id = v_order.organization_id and pay.request_id = p_request_id;
  if found then
    return v_existing;
  end if;

  if p_amount_cents > v_order.paid_cents - v_order.refunded_cents then
    raise exception 'finance.refund_exceeds';
  end if;

  insert into public.order_payments (
    organization_id, order_id, kind, method, amount_cents, note, request_id, created_by
  ) values (
    v_order.organization_id, p_order, 'refund', p_method, p_amount_cents,
    nullif(btrim(p_note), ''), p_request_id, auth.uid()
  )
  returning id into v_id;

  insert into public.ledger_entries (
    organization_id, kind, amount_cents, order_id, description, created_by, request_id
  ) values (
    v_order.organization_id, 'refund', -p_amount_cents, p_order,
    'Estorno do pedido #' || v_order.number, auth.uid(), v_id
  );

  update public.orders set refunded_cents = refunded_cents + p_amount_cents where id = p_order;
  return v_id;
end;
$$;

/**
 * O vendedor paga o atacado de um pedido de fornecimento já enviado:
 * débito no livro dele e crédito no do fornecedor, na mesma transação.
 * Sem parâmetro de idempotência: o estado (`paid_at`) já impede repetir.
 */
create function public.pay_supplier_order(p_supplier_order uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_so public.supplier_orders%rowtype;
  v_seller_order public.orders%rowtype;
begin
  select * into v_so from public.supplier_orders so where so.id = p_supplier_order;
  if v_so.id is null or not private.has_org_role(v_so.seller_organization_id, '{owner,admin}') then
    raise exception 'finance.not_found';
  end if;

  -- Mesma ordem de travas das RPCs de pedido (pedido → fornecimento).
  select * into v_seller_order from public.orders o where o.id = v_so.order_id for update;
  select * into v_so from public.supplier_orders so where so.id = p_supplier_order for update;

  if v_so.paid_at is not null then
    raise exception 'finance.already_paid';
  end if;
  if v_so.status <> 'shipped' then
    raise exception 'finance.not_payable';
  end if;

  insert into public.ledger_entries (
    organization_id, kind, amount_cents, order_id, supplier_order_id, description, created_by, request_id
  ) values
    (v_so.seller_organization_id, 'supplier_payment', -v_so.total_wholesale_cents,
     v_so.order_id, v_so.id, 'Pagamento ao fornecedor — pedido #' || v_seller_order.number,
     auth.uid(), v_so.id),
    (v_so.organization_id, 'supplier_receipt', v_so.total_wholesale_cents,
     v_so.order_id, v_so.id, 'Recebimento do fornecimento #' || v_so.number,
     auth.uid(), v_so.id);

  update public.supplier_orders set paid_at = now() where id = p_supplier_order;
end;
$$;

/**
 * Resumo do período (owner/admin). `payable_cents`: o que o vendedor deve a
 * fornecedores (enviados e não pagos). `receivable_cents`: o que o fornecedor
 * tem a receber. Ambos independem do período.
 */
create function public.finance_summary(p_org uuid, p_from timestamptz, p_to timestamptz)
returns table (
  received_cents bigint,
  refunded_cents bigint,
  supplier_paid_cents bigint,
  supplier_received_cents bigint,
  net_cents bigint,
  payable_cents bigint,
  receivable_cents bigint
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
  select
    coalesce(sum(e.amount_cents) filter (where e.kind = 'sale_payment'), 0)::bigint,
    coalesce(-sum(e.amount_cents) filter (where e.kind = 'refund'), 0)::bigint,
    coalesce(-sum(e.amount_cents) filter (where e.kind = 'supplier_payment'), 0)::bigint,
    coalesce(sum(e.amount_cents) filter (where e.kind = 'supplier_receipt'), 0)::bigint,
    coalesce(sum(e.amount_cents), 0)::bigint,
    (select coalesce(sum(so.total_wholesale_cents), 0) from public.supplier_orders so
      where so.seller_organization_id = p_org and so.status = 'shipped' and so.paid_at is null)::bigint,
    (select coalesce(sum(so.total_wholesale_cents), 0) from public.supplier_orders so
      where so.organization_id = p_org and so.status = 'shipped' and so.paid_at is null)::bigint
  from public.ledger_entries e
  where e.organization_id = p_org
    and (p_from is null or e.created_at >= p_from)
    and (p_to is null or e.created_at < p_to);
end;
$$;

grant execute on function public.record_order_payment(uuid, bigint, public.payment_method, text, uuid) to authenticated;
grant execute on function public.refund_order_payment(uuid, bigint, public.payment_method, text, uuid) to authenticated;
grant execute on function public.pay_supplier_order(uuid) to authenticated;
grant execute on function public.finance_summary(uuid, timestamptz, timestamptz) to authenticated;
