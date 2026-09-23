// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerMember: string;
let supplier: string;
let outsider: string;
let sellerOrg: string;
let supplierOrg: string;
let ownItem: string;
let importedItem: string;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

async function rows<T>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, userId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

const customer = {
  customer_name: 'Maria Cliente',
  ship_postal_code: '01310100',
  ship_street: 'Av. Paulista',
  ship_number: '1000',
  ship_district: 'Bela Vista',
  ship_city: 'São Paulo',
  ship_state: 'SP',
};

const createOrder = (items: { inventory_item_id: string; quantity: number }[]) =>
  scalar<string>(seller, 'select public.create_order($1, $2, $3)', [
    sellerOrg,
    JSON.stringify({ ...customer, items }),
    crypto.randomUUID(),
  ]);

const call = (userId: string, fn: string, id: string) =>
  scalar(userId, `select public.${fn}($1)`, [id]);

const pay = (order: string, cents: number, userId = seller, req = crypto.randomUUID()) =>
  scalar<string>(userId, "select public.record_order_payment($1, $2, 'pix', null, $3)", [
    order,
    cents,
    req,
  ]);

const refund = (order: string, cents: number, userId = seller) =>
  scalar<string>(userId, "select public.refund_order_payment($1, $2, 'pix', 'motivo', $3)", [
    order,
    cents,
    crypto.randomUUID(),
  ]);

async function orderRow(id: string) {
  const res = await db.query<{ paid_cents: string; refunded_cents: string }>(
    'select paid_cents, refunded_cents from public.orders where id = $1',
    [id],
  );
  return { paid: Number(res.rows[0]!.paid_cents), refunded: Number(res.rows[0]!.refunded_cents) };
}

async function ledger(org: string) {
  const res = await db.query<{ kind: string; amount_cents: string }>(
    'select kind, amount_cents from public.ledger_entries where organization_id = $1 order by created_at, amount_cents',
    [org],
  );
  return res.rows.map((r) => ({ kind: r.kind, amount: Number(r.amount_cents) }));
}

/** Pedido só de fornecedor (2 × 2.000 de atacado), confirmado e enviado pelo fornecedor. */
async function shippedSupplierOrder() {
  const order = await createOrder([{ inventory_item_id: importedItem, quantity: 2 }]);
  await call(seller, 'confirm_order', order);
  const so = await scalar<string>(
    supplier,
    'select id from public.supplier_orders where order_id = $1',
    [order],
  );
  await scalar(supplier, "select public.ship_supplier_order($1, 'Correios', 'BR123456789')", [so]);
  return { order, so };
}

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  sellerMember = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Forn',
    account_type: 'supplier',
  });
  outsider = await signUpUser(db, 'out@example.com', { full_name: 'Outra Loja' });
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  supplierOrg = await scalar(supplier, "select public.create_organization('Fábrica X')");
  await scalar(outsider, "select public.create_organization('Loja W')");
  const inv = await scalar<string>(
    seller,
    "select public.invite_member($1, 'membro@example.com', 'member')",
    [sellerOrg],
  );
  await scalar(sellerMember, 'select public.accept_invitation($1)', [inv]);

  const own = await scalar<string>(
    seller,
    "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, 'PROPRIO', 'Caneca', 3000, 'active') returning id",
    [sellerOrg],
  );
  ownItem = await scalar(seller, 'select id from public.inventory_items where product_id = $1', [
    own,
  ]);
  await scalar(seller, "select public.adjust_stock($1, 10, 'purchase', null, gen_random_uuid())", [
    ownItem,
  ]);

  const sp = await scalar<string>(
    supplier,
    "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, 'CAN', 'Caneca X', 4000, 'active') returning id",
    [supplierOrg],
  );
  const supplierItem = await scalar<string>(
    supplier,
    'select id from public.inventory_items where product_id = $1',
    [sp],
  );
  await scalar(supplier, "select public.adjust_stock($1, 5, 'purchase', null, gen_random_uuid())", [
    supplierItem,
  ]);
  const listing = await scalar<string>(
    supplier,
    `insert into public.catalog_listings (organization_id, product_id, wholesale_price_cents, suggested_price_cents, is_published)
     values ($1, $2, 2000, 5990, true) returning id`,
    [supplierOrg, sp],
  );
  const imported = await scalar<string>(
    seller,
    "select public.import_catalog_listing($1, $2, 'FX-')",
    [sellerOrg, listing],
  );
  await scalar(seller, "update public.products set status = 'active' where id = $1", [imported]);
  importedItem = await scalar(
    seller,
    'select id from public.inventory_items where product_id = $1',
    [imported],
  );
});

afterEach(async () => {
  await db.close();
});

describe('financeiro: recebimentos', () => {
  it('registra recebimento parcial e total e lança no livro-razão', async () => {
    const order = await createOrder([{ inventory_item_id: ownItem, quantity: 2 }]); // 6.000
    await pay(order, 2500);
    expect(await orderRow(order)).toEqual({ paid: 2500, refunded: 0 });
    await pay(order, 3500);
    expect(await orderRow(order)).toEqual({ paid: 6000, refunded: 0 });
    expect(await ledger(sellerOrg)).toEqual([
      { kind: 'sale_payment', amount: 2500 },
      { kind: 'sale_payment', amount: 3500 },
    ]);
  });

  it('é idempotente pelo request_id', async () => {
    const order = await createOrder([{ inventory_item_id: ownItem, quantity: 1 }]);
    const req = crypto.randomUUID();
    const a = await pay(order, 1000, seller, req);
    const b = await pay(order, 1000, seller, req);
    expect(b).toBe(a);
    expect(await orderRow(order)).toEqual({ paid: 1000, refunded: 0 });
    expect(await ledger(sellerOrg)).toHaveLength(1);
  });

  it('rejeita pagamento acima do total, valor inválido e pedido cancelado', async () => {
    const order = await createOrder([{ inventory_item_id: ownItem, quantity: 1 }]); // 3.000
    await pay(order, 2000);
    await expect(pay(order, 1001)).rejects.toThrow(/finance.overpayment/);
    await expect(pay(order, 0)).rejects.toThrow(/finance.invalid/);
    await expect(pay(order, -5)).rejects.toThrow(/finance.invalid/);
    await call(seller, 'cancel_order', order);
    await expect(pay(order, 100)).rejects.toThrow(/finance.order_cancelled/);
    expect(await orderRow(order)).toEqual({ paid: 2000, refunded: 0 });
  });

  it('só owner/admin registram; membro e outra organização não', async () => {
    const order = await createOrder([{ inventory_item_id: ownItem, quantity: 1 }]);
    await expect(pay(order, 1000, sellerMember)).rejects.toThrow(/orders.not_found/);
    await expect(pay(order, 1000, outsider)).rejects.toThrow(/orders.not_found/);
    await expect(pay(order, 1000, supplier)).rejects.toThrow(/orders.not_found/);
    expect(await ledger(sellerOrg)).toEqual([]);
  });
});

describe('financeiro: estornos', () => {
  it('estorna até o líquido recebido e libera novo recebimento', async () => {
    const order = await createOrder([{ inventory_item_id: ownItem, quantity: 1 }]); // 3.000
    await pay(order, 3000);
    await refund(order, 1000);
    expect(await orderRow(order)).toEqual({ paid: 3000, refunded: 1000 });
    await expect(refund(order, 2001)).rejects.toThrow(/finance.refund_exceeds/);
    await refund(order, 2000);
    await pay(order, 3000); // líquido voltou a zero
    expect(await orderRow(order)).toEqual({ paid: 6000, refunded: 3000 });
    const net = await scalar<string>(seller, 'select sum(amount_cents) from public.ledger_entries');
    expect(Number(net)).toBe(3000);
  });

  it('não estorna sem recebimento e respeita permissão', async () => {
    const order = await createOrder([{ inventory_item_id: ownItem, quantity: 1 }]);
    await expect(refund(order, 100)).rejects.toThrow(/finance.refund_exceeds/);
    await pay(order, 1000);
    await expect(refund(order, 100, sellerMember)).rejects.toThrow(/orders.not_found/);
  });

  it('permite estornar pedido cancelado', async () => {
    const order = await createOrder([{ inventory_item_id: ownItem, quantity: 1 }]);
    await pay(order, 3000);
    await call(seller, 'cancel_order', order);
    await refund(order, 3000);
    expect(await orderRow(order)).toEqual({ paid: 3000, refunded: 3000 });
  });
});

describe('financeiro: acerto com fornecedor', () => {
  it('só paga depois do envio e credita o fornecedor na mesma transação', async () => {
    const order = await createOrder([{ inventory_item_id: importedItem, quantity: 2 }]);
    await call(seller, 'confirm_order', order);
    const so = await scalar<string>(
      supplier,
      'select id from public.supplier_orders where order_id = $1',
      [order],
    );
    await expect(call(seller, 'pay_supplier_order', so)).rejects.toThrow(/finance.not_payable/);

    await scalar(supplier, "select public.ship_supplier_order($1, 'Correios', 'BR123456789')", [
      so,
    ]);
    await call(seller, 'pay_supplier_order', so);

    expect(await ledger(sellerOrg)).toEqual([{ kind: 'supplier_payment', amount: -4000 }]);
    expect(await ledger(supplierOrg)).toEqual([{ kind: 'supplier_receipt', amount: 4000 }]);
    const paid = await db.query('select paid_at from public.supplier_orders where id = $1', [so]);
    expect(paid.rows[0]).toMatchObject({ paid_at: expect.anything() });
    await expect(call(seller, 'pay_supplier_order', so)).rejects.toThrow(/finance.already_paid/);
    expect(await ledger(sellerOrg)).toHaveLength(1);
  });

  it('fornecedor, membro e outras lojas não pagam', async () => {
    const { so } = await shippedSupplierOrder();
    await expect(call(supplier, 'pay_supplier_order', so)).rejects.toThrow(/finance.not_found/);
    await expect(call(sellerMember, 'pay_supplier_order', so)).rejects.toThrow(/finance.not_found/);
    await expect(call(outsider, 'pay_supplier_order', so)).rejects.toThrow(/finance.not_found/);
    expect(await ledger(supplierOrg)).toEqual([]);
  });

  it('pedido cancelado não gera pagamento', async () => {
    const order = await createOrder([{ inventory_item_id: importedItem, quantity: 1 }]);
    await call(seller, 'confirm_order', order);
    const so = await scalar<string>(
      supplier,
      'select id from public.supplier_orders where order_id = $1',
      [order],
    );
    await call(seller, 'cancel_order', order);
    await expect(call(seller, 'pay_supplier_order', so)).rejects.toThrow(/finance.not_payable/);
  });
});

describe('financeiro: livro-razão e privacidade', () => {
  it('é imutável, inclusive para service role', async () => {
    const order = await createOrder([{ inventory_item_id: ownItem, quantity: 1 }]);
    await pay(order, 1000);
    await expect(db.query('update public.ledger_entries set amount_cents = 1')).rejects.toThrow(
      /finance.ledger_immutable/,
    );
    await expect(db.query('delete from public.ledger_entries')).rejects.toThrow(
      /finance.ledger_immutable/,
    );
    await expect(db.query('truncate public.ledger_entries')).rejects.toThrow(
      /finance.ledger_immutable/,
    );
  });

  it('não permite escrita direta nem trocar o saldo do pedido', async () => {
    const order = await createOrder([{ inventory_item_id: ownItem, quantity: 1 }]);
    await expect(
      scalar(
        seller,
        "insert into public.ledger_entries (organization_id, kind, amount_cents, request_id) values ($1, 'sale_payment', 100, gen_random_uuid())",
        [sellerOrg],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      scalar(seller, 'update public.orders set paid_cents = 100 where id = $1', [order]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      scalar(
        seller,
        "insert into public.order_payments (organization_id, order_id, kind, method, amount_cents, request_id) values ($1, $2, 'payment', 'pix', 100, gen_random_uuid())",
        [sellerOrg, order],
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('só owner/admin leem lançamentos e pagamentos, e só da própria organização', async () => {
    const order = await createOrder([{ inventory_item_id: ownItem, quantity: 1 }]);
    await pay(order, 1000);
    expect(await rows(seller, 'select 1 from public.ledger_entries')).toHaveLength(1);
    expect(await rows(seller, 'select 1 from public.order_payments')).toHaveLength(1);
    for (const user of [sellerMember, outsider, supplier]) {
      expect(await rows(user, 'select 1 from public.ledger_entries')).toEqual([]);
      expect(await rows(user, 'select 1 from public.order_payments')).toEqual([]);
    }
  });

  it('o CHECK do livro-razão barra sinal incompatível com o tipo', async () => {
    await expect(
      db.query(
        "insert into public.ledger_entries (organization_id, kind, amount_cents, request_id) values ($1, 'refund', 100, gen_random_uuid())",
        [sellerOrg],
      ),
    ).rejects.toThrow(/check/);
  });
});

describe('financeiro: resumo', () => {
  it('soma recebido, estornos, acertos e pendências', async () => {
    const own = await createOrder([{ inventory_item_id: ownItem, quantity: 2 }]); // 6.000
    await pay(own, 6000);
    await refund(own, 1500);
    const paidSo = await shippedSupplierOrder(); // 4.000
    await call(seller, 'pay_supplier_order', paidSo.so);
    await shippedSupplierOrder(); // 4.000 em aberto

    const summary = (userId: string, org: string) =>
      rows<Record<string, string>>(userId, 'select * from public.finance_summary($1, null, null)', [
        org,
      ]).then((r) => Object.fromEntries(Object.entries(r[0]!).map(([k, v]) => [k, Number(v)])));

    expect(await summary(seller, sellerOrg)).toEqual({
      received_cents: 6000,
      refunded_cents: 1500,
      supplier_paid_cents: 4000,
      supplier_received_cents: 0,
      net_cents: 500,
      payable_cents: 4000,
      receivable_cents: 0,
    });
    expect(await summary(supplier, supplierOrg)).toEqual({
      received_cents: 0,
      refunded_cents: 0,
      supplier_paid_cents: 0,
      supplier_received_cents: 4000,
      net_cents: 4000,
      payable_cents: 0,
      receivable_cents: 4000,
    });
  });

  it('respeita o período e a permissão', async () => {
    const order = await createOrder([{ inventory_item_id: ownItem, quantity: 1 }]);
    await pay(order, 1000);
    const future = await scalar<string>(
      seller,
      "select count(*) from public.finance_summary($1, now() + interval '1 day', null) where received_cents = 0",
      [sellerOrg],
    );
    expect(Number(future)).toBe(1);
    await expect(
      scalar(sellerMember, 'select * from public.finance_summary($1, null, null)', [sellerOrg]),
    ).rejects.toThrow(/org.forbidden/);
    await expect(
      scalar(outsider, 'select * from public.finance_summary($1, null, null)', [sellerOrg]),
    ).rejects.toThrow(/org.forbidden/);
  });
});
