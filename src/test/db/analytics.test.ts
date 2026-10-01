// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import {
  approveCatalog,
  asUser,
  connectMercadoLivre,
  createTestDatabase,
  signUpUser,
} from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerMember: string;
let supplier: string;
let outsider: string;
let outsiderOrg: string;
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
  outsiderOrg = await scalar(outsider, "select public.create_organization('Loja W')");
  const inv = await scalar<string>(
    seller,
    "select public.invite_member($1, 'membro@example.com', 'member')",
    [sellerOrg],
  );
  await scalar(sellerMember, 'select public.accept_invitation($1)', [inv]);

  const own = await scalar<string>(
    seller,
    "insert into public.products (organization_id, sku, name, price_cents, cost_cents, status) values ($1, 'PROPRIO', 'Caneca', 3000, 1000, 'active') returning id",
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
  await approveCatalog(db);

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

const overview = (userId: string, org: string, days = 30) =>
  scalar<Record<string, number | string>>(userId, 'select public.analytics_overview($1, $2)', [
    org,
    days,
  ]);

describe('analytics: vendedor', () => {
  it('soma vendas, custo, margem e ignora cancelados', async () => {
    const a = await createOrder([{ inventory_item_id: ownItem, quantity: 2 }]); // 6.000, custo 2.000
    const cancelled = await createOrder([{ inventory_item_id: ownItem, quantity: 1 }]);
    await call(seller, 'cancel_order', cancelled);
    const drop = await createOrder([{ inventory_item_id: importedItem, quantity: 1 }]); // 5.990, atacado 2.000
    await call(seller, 'confirm_order', drop);
    void a;

    const o = await overview(seller, sellerOrg);
    expect(o).toMatchObject({
      kind: 'seller',
      orders: 2,
      cancelled: 1,
      revenue_cents: 11990,
      goods_revenue_cents: 11990,
      units: 3,
      goods_cost_cents: 4000,
      gross_profit_cents: 7990,
      avg_ticket_cents: 5995,
      units_without_cost: 0,
      marketplace_orders: 0,
      pending: 1,
      confirmed: 1,
    });
  });

  it('série diária cobre todos os dias e o dia de hoje recebe os pedidos', async () => {
    await createOrder([{ inventory_item_id: ownItem, quantity: 1 }]);
    const days = await rows<{ day: string; orders: number; amount_cents: number }>(
      seller,
      'select * from public.analytics_daily($1, 7)',
      [sellerOrg],
    );
    expect(days).toHaveLength(7);
    expect(days.slice(0, 6).every((d) => Number(d.orders) === 0)).toBe(true);
    expect(days[6]).toMatchObject({ orders: 1, amount_cents: 3000 });
  });

  it('mais vendidos ordenam por unidades', async () => {
    await createOrder([{ inventory_item_id: ownItem, quantity: 3 }]);
    await createOrder([{ inventory_item_id: importedItem, quantity: 1 }]);
    const top = await rows<{ sku: string; units: number }>(
      seller,
      'select * from public.analytics_top_items($1, 30, 5)',
      [sellerOrg],
    );
    expect(top.map((t) => [t.sku, Number(t.units)])).toEqual([
      ['PROPRIO', 3],
      ['FX-CAN', 1],
    ]);
  });

  it('marca pedidos vindos de marketplace', async () => {
    const order = await createOrder([{ inventory_item_id: ownItem, quantity: 1 }]);
    const conn = await connectMercadoLivre(db, seller, sellerOrg);
    await db.query(
      "insert into public.external_orders (organization_id, connection_id, external_id, order_id) values ($1, $2, '1', $3)",
      [sellerOrg, conn, order],
    );
    expect((await overview(seller, sellerOrg)).marketplace_orders).toBe(1);
  });
});

describe('analytics: fornecedor e permissões', () => {
  it('fornecedor vê fornecimentos, pendências e a receber', async () => {
    const { order } = await shippedSupplierOrder(); // 4.000 enviado, não pago
    void order;
    const pending = await createOrder([{ inventory_item_id: importedItem, quantity: 1 }]);
    await call(seller, 'confirm_order', pending); // 2.000 aguardando envio
    const o = await overview(supplier, supplierOrg);
    expect(o).toMatchObject({
      kind: 'supplier',
      orders: 2,
      wholesale_cents: 6000,
      awaiting_shipment: 1,
      shipped: 1,
      unpaid_cents: 4000,
      units: 3,
      avg_ticket_cents: 3000,
    });
    const top = await rows<{ units: number }>(
      supplier,
      'select * from public.analytics_top_items($1, 30)',
      [supplierOrg],
    );
    expect(Number(top[0]!.units)).toBe(3);
  });

  it('membro, outra organização e período inválido são barrados', async () => {
    await expect(overview(sellerMember, sellerOrg)).rejects.toThrow(/org.forbidden/);
    await expect(overview(outsider, sellerOrg)).rejects.toThrow(/org.forbidden/);
    await expect(overview(supplier, sellerOrg)).rejects.toThrow(/org.forbidden/);
    await expect(overview(seller, sellerOrg, 0)).rejects.toThrow(/analytics.invalid_period/);
    await expect(overview(seller, sellerOrg, 400)).rejects.toThrow(/analytics.invalid_period/);
  });

  it('não mistura organizações', async () => {
    await createOrder([{ inventory_item_id: ownItem, quantity: 1 }]);
    const o = await overview(outsider, outsiderOrg);
    expect(o).toMatchObject({ orders: 0, revenue_cents: 0, units: 0 });
  });
});
