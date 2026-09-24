// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { approveCatalog, asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerMember: string;
let supplier: string;
let supplier2: string;
let outsider: string;
let sellerOrg: string;
let supplierOrg: string;

// Seller's own product (sold from own stock).
let ownItem: string;
// Supplier product with a variant, published and imported by the seller.
let supplierVariantItem: string;
let listing: string;
let importedVariantItem: string;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

async function rows<T>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, userId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

async function stock(item: string) {
  const res = await db.query<{ on_hand: number; reserved: number }>(
    'select on_hand, reserved from public.inventory_items where id = $1',
    [item],
  );
  return res.rows[0];
}

const addStock = (userId: string, item: string, qty: number) =>
  scalar(userId, "select public.adjust_stock($1, $2, 'purchase', null, gen_random_uuid())", [
    item,
    qty,
  ]);

const customer = {
  customer_name: 'Maria Cliente',
  customer_email: 'maria@example.com',
  customer_phone: '11987654321',
  customer_document: '12345678909',
  ship_postal_code: '01310100',
  ship_street: 'Av. Paulista',
  ship_number: '1000',
  ship_district: 'Bela Vista',
  ship_city: 'São Paulo',
  ship_state: 'SP',
};

function createOrder(
  items: { inventory_item_id: string; quantity: number; unit_price_cents?: number }[],
  extra: Record<string, unknown> = {},
  userId = seller,
  requestId: string = crypto.randomUUID(),
) {
  return scalar<string>(userId, 'select public.create_order($1, $2, $3)', [
    sellerOrg,
    JSON.stringify({ ...customer, items, ...extra }),
    requestId,
  ]);
}

const call = (userId: string, fn: string, id: string) =>
  scalar(userId, `select public.${fn}($1)`, [id]);

async function orderRow(id: string) {
  const res = await db.query<Record<string, unknown>>('select * from public.orders where id = $1', [
    id,
  ]);
  return res.rows[0]!;
}

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  sellerMember = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Forn',
    account_type: 'supplier',
  });
  supplier2 = await signUpUser(db, 'forn2@example.com', {
    full_name: 'Forn 2',
    account_type: 'supplier',
  });
  outsider = await signUpUser(db, 'out@example.com', { full_name: 'Outra Loja' });
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  supplierOrg = await scalar(supplier, "select public.create_organization('Fábrica X')");
  await scalar(supplier2, "select public.create_organization('Fábrica Y')");
  await scalar(outsider, "select public.create_organization('Loja W')");
  const inv = await scalar<string>(
    seller,
    "select public.invite_member($1, 'membro@example.com', 'member')",
    [sellerOrg],
  );
  await scalar(sellerMember, 'select public.accept_invitation($1)', [inv]);

  // Own product with 10 units.
  const own = await scalar<string>(
    seller,
    "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, 'PROPRIO', 'Caneca', 3000, 'active') returning id",
    [sellerOrg],
  );
  ownItem = await scalar(seller, 'select id from public.inventory_items where product_id = $1', [
    own,
  ]);
  await addStock(seller, ownItem, 10);

  // Supplier product with one variant (5 units), published at 2.000 wholesale.
  const sp = await scalar<string>(
    supplier,
    "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, 'CAM', 'Camiseta', 9000, 'active') returning id",
    [supplierOrg],
  );
  const sv = await scalar<string>(
    supplier,
    `insert into public.product_variants (organization_id, product_id, sku, attributes)
     values ($1, $2, 'CAM-AZ', '{"Cor":"Azul"}') returning id`,
    [supplierOrg, sp],
  );
  supplierVariantItem = await scalar(
    supplier,
    'select id from public.inventory_items where variant_id = $1',
    [sv],
  );
  await addStock(supplier, supplierVariantItem, 5);
  listing = await scalar(
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
  importedVariantItem = await scalar(
    seller,
    'select id from public.inventory_items where product_id = $1 and variant_id is not null',
    [imported],
  );
});

afterEach(async () => {
  await db.close();
});

describe('pedidos: criação', () => {
  it('cria pedido pendente com snapshot, totais e numeração sequencial', async () => {
    const a = await createOrder([{ inventory_item_id: ownItem, quantity: 2 }], {
      shipping_cents: 1500,
      discount_cents: 500,
    });
    const b = await createOrder([
      { inventory_item_id: ownItem, quantity: 1, unit_price_cents: 2500 },
    ]);
    expect(await orderRow(a)).toMatchObject({
      number: 1,
      status: 'pending',
      subtotal_cents: 6000,
      shipping_cents: 1500,
      discount_cents: 500,
      total_cents: 7000,
      created_by: seller,
    });
    expect(await orderRow(b)).toMatchObject({ number: 2, total_cents: 2500 });
    const items = await db.query(
      'select sku, name, fulfillment from public.order_items where order_id = $1',
      [a],
    );
    expect(items.rows).toEqual([{ sku: 'PROPRIO', name: 'Caneca', fulfillment: 'own_stock' }]);
    // Creating does not touch stock.
    expect(await stock(ownItem)).toEqual({ on_hand: 10, reserved: 0 });
  });

  it('é idempotente pelo request_id', async () => {
    const req = crypto.randomUUID();
    const a = await createOrder([{ inventory_item_id: ownItem, quantity: 1 }], {}, seller, req);
    const b = await createOrder([{ inventory_item_id: ownItem, quantity: 1 }], {}, seller, req);
    expect(b).toBe(a);
    const count = await db.query('select 1 from public.orders');
    expect(count.rows).toHaveLength(1);
  });

  it('marca itens importados como fornecimento', async () => {
    const id = await createOrder([{ inventory_item_id: importedVariantItem, quantity: 1 }]);
    const items = await db.query<{ sku: string; fulfillment: string; unit_price_cents: number }>(
      'select sku, fulfillment, unit_price_cents from public.order_items where order_id = $1',
      [id],
    );
    expect(items.rows).toEqual([
      { sku: 'FX-CAM-AZ', fulfillment: 'supplier', unit_price_cents: 5990 },
    ]);
  });

  it('rejeita itens inválidos, de outra organização ou indisponíveis', async () => {
    await expect(createOrder([])).rejects.toThrow(/orders.invalid_items/);
    await expect(createOrder([{ inventory_item_id: ownItem, quantity: 0 }])).rejects.toThrow(
      /orders.invalid_items/,
    );
    await expect(
      createOrder([
        { inventory_item_id: ownItem, quantity: 1 },
        { inventory_item_id: ownItem, quantity: 1 },
      ]),
    ).rejects.toThrow(/orders.invalid_items/);
    await expect(
      createOrder([{ inventory_item_id: supplierVariantItem, quantity: 1 }]),
    ).rejects.toThrow(/orders.invalid_items/);
    await scalar(seller, "update public.products set status = 'archived' where sku = 'PROPRIO'");
    await expect(createOrder([{ inventory_item_id: ownItem, quantity: 1 }])).rejects.toThrow(
      /orders.item_unavailable/,
    );
  });

  it('rejeita desconto maior que o total e endereço inválido', async () => {
    await expect(
      createOrder([{ inventory_item_id: ownItem, quantity: 1 }], { discount_cents: 999999 }),
    ).rejects.toThrow(/orders.invalid_discount/);
    await expect(
      createOrder([{ inventory_item_id: ownItem, quantity: 1 }], { ship_state: 'São Paulo' }),
    ).rejects.toThrow(/check constraint/);
  });

  it('só owner/admin de organização vendedora criam', async () => {
    await expect(
      createOrder([{ inventory_item_id: ownItem, quantity: 1 }], {}, sellerMember),
    ).rejects.toThrow(/org.forbidden/);
    await expect(
      createOrder([{ inventory_item_id: ownItem, quantity: 1 }], {}, outsider),
    ).rejects.toThrow(/org.forbidden/);
    await expect(
      scalar(seller, 'insert into public.orders (organization_id) values ($1)', [sellerOrg]),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('pedidos: estoque próprio', () => {
  it('confirmar reserva, enviar dá baixa com movimentação de venda', async () => {
    const id = await createOrder([{ inventory_item_id: ownItem, quantity: 3 }]);
    await call(seller, 'confirm_order', id);
    expect(await stock(ownItem)).toEqual({ on_hand: 10, reserved: 3 });

    await call(seller, 'ship_order', id);
    expect(await stock(ownItem)).toEqual({ on_hand: 7, reserved: 0 });
    const moves = await db.query<{ reason: string; quantity_delta: number; note: string }>(
      "select reason, quantity_delta, note from public.inventory_movements where item_id = $1 and reason = 'sale'",
      [ownItem],
    );
    expect(moves.rows).toEqual([{ reason: 'sale', quantity_delta: -3, note: 'Pedido #1' }]);

    await call(seller, 'deliver_order', id);
    expect((await orderRow(id)).status).toBe('delivered');
  });

  it('confirmação sem estoque falha inteira (nada reservado)', async () => {
    const id = await createOrder([
      { inventory_item_id: ownItem, quantity: 2 },
      { inventory_item_id: importedVariantItem, quantity: 6 }, // supplier has 5
    ]);
    await expect(call(seller, 'confirm_order', id)).rejects.toThrow(/orders.insufficient_stock/);
    expect(await stock(ownItem)).toEqual({ on_hand: 10, reserved: 0 });
    expect(await stock(supplierVariantItem)).toEqual({ on_hand: 5, reserved: 0 });
    expect((await orderRow(id)).status).toBe('pending');
  });

  it('cancelar pedido confirmado libera a reserva', async () => {
    const id = await createOrder([{ inventory_item_id: ownItem, quantity: 4 }]);
    await call(seller, 'confirm_order', id);
    await call(seller, 'cancel_order', id);
    expect(await stock(ownItem)).toEqual({ on_hand: 10, reserved: 0 });
    expect((await orderRow(id)).status).toBe('cancelled');
    await expect(call(seller, 'confirm_order', id)).rejects.toThrow(/orders.invalid_status/);
  });

  it('reserva impede que o estoque reservado seja vendido de novo ou baixado por ajuste', async () => {
    const a = await createOrder([{ inventory_item_id: ownItem, quantity: 8 }]);
    await call(seller, 'confirm_order', a);
    const b = await createOrder([{ inventory_item_id: ownItem, quantity: 3 }]);
    await expect(call(seller, 'confirm_order', b)).rejects.toThrow(/orders.insufficient_stock/);
    await expect(
      scalar(seller, "select public.adjust_stock($1, -3, 'loss', null, gen_random_uuid())", [
        ownItem,
      ]),
    ).rejects.toThrow(/inventory.insufficient_stock/);
  });

  it('status inválidos são recusados', async () => {
    const id = await createOrder([{ inventory_item_id: ownItem, quantity: 1 }]);
    await expect(call(seller, 'ship_order', id)).rejects.toThrow(/orders.invalid_status/);
    await expect(call(seller, 'deliver_order', id)).rejects.toThrow(/orders.invalid_status/);
    await call(seller, 'confirm_order', id);
    await expect(call(seller, 'confirm_order', id)).rejects.toThrow(/orders.invalid_status/);
    await call(seller, 'ship_order', id);
    await expect(call(seller, 'cancel_order', id)).rejects.toThrow(/orders.invalid_status/);
  });
});

describe('pedidos: dropshipping', () => {
  it('confirmar cria pedido de fornecimento com atacado e reserva no fornecedor', async () => {
    const id = await createOrder([
      { inventory_item_id: importedVariantItem, quantity: 2 },
      { inventory_item_id: ownItem, quantity: 1 },
    ]);
    await call(seller, 'confirm_order', id);

    expect(await stock(supplierVariantItem)).toEqual({ on_hand: 5, reserved: 2 });
    expect(await stock(importedVariantItem)).toEqual({ on_hand: 0, reserved: 0 });
    expect(await stock(ownItem)).toEqual({ on_hand: 10, reserved: 1 });

    const so = await rows<Record<string, unknown>>(
      supplier,
      'select number, status, recipient_name, ship_city, total_wholesale_cents from public.supplier_orders',
    );
    expect(so).toEqual([
      {
        number: 1,
        status: 'pending',
        recipient_name: 'Maria Cliente',
        ship_city: 'São Paulo',
        total_wholesale_cents: 4000,
      },
    ]);
    const soi = await rows<Record<string, unknown>>(
      supplier,
      'select sku, quantity, unit_wholesale_cents from public.supplier_order_items',
    );
    expect(soi).toEqual([{ sku: 'CAM-AZ', quantity: 2, unit_wholesale_cents: 2000 }]);
  });

  it('fornecedor vê só dados de entrega; não lê o pedido do vendedor', async () => {
    const id = await createOrder([{ inventory_item_id: importedVariantItem, quantity: 1 }], {
      notes: 'cliente VIP',
    });
    await call(seller, 'confirm_order', id);
    expect(await rows(supplier, 'select 1 from public.orders')).toEqual([]);
    expect(await rows(supplier, 'select 1 from public.order_items')).toEqual([]);
    const so = await rows<Record<string, unknown>>(
      supplier,
      'select * from public.supplier_orders',
    );
    const json = JSON.stringify(so);
    for (const secret of ['maria@example.com', 'cliente VIP', '5990']) {
      expect(json).not.toContain(secret);
    }
    // Other suppliers and other sellers see nothing.
    expect(await rows(supplier2, 'select 1 from public.supplier_orders')).toEqual([]);
    expect(await rows(outsider, 'select 1 from public.supplier_orders')).toEqual([]);
    // The seller follows the supplier order.
    expect(await rows(seller, 'select 1 from public.supplier_orders')).toHaveLength(1);
  });

  it('vendedor só envia depois do fornecedor; fornecedor dá baixa e informa rastreio', async () => {
    const id = await createOrder([{ inventory_item_id: importedVariantItem, quantity: 2 }]);
    await call(seller, 'confirm_order', id);
    await expect(call(seller, 'ship_order', id)).rejects.toThrow(/orders.awaiting_supplier/);

    const soId = await scalar<string>(supplier, 'select id from public.supplier_orders');
    await expect(
      scalar(supplier2, "select public.ship_supplier_order($1, 'Correios', 'BR123456789BR')", [
        soId,
      ]),
    ).rejects.toThrow(/orders.not_found/);
    await expect(
      scalar(seller, "select public.ship_supplier_order($1, 'Correios', 'BR123456789BR')", [soId]),
    ).rejects.toThrow(/orders.not_found/);

    await scalar(supplier, "select public.ship_supplier_order($1, 'Correios', 'BR123456789BR')", [
      soId,
    ]);
    expect(await stock(supplierVariantItem)).toEqual({ on_hand: 3, reserved: 0 });
    expect(
      await rows(seller, 'select status, carrier, tracking_code from public.supplier_orders'),
    ).toEqual([{ status: 'shipped', carrier: 'Correios', tracking_code: 'BR123456789BR' }]);

    await call(seller, 'ship_order', id);
    expect((await orderRow(id)).status).toBe('shipped');
  });

  it('cancelar libera a reserva do fornecedor; depois do envio do fornecedor, não cancela', async () => {
    const a = await createOrder([{ inventory_item_id: importedVariantItem, quantity: 2 }]);
    await call(seller, 'confirm_order', a);
    await call(seller, 'cancel_order', a);
    expect(await stock(supplierVariantItem)).toEqual({ on_hand: 5, reserved: 0 });
    expect(await rows(supplier, 'select status from public.supplier_orders')).toEqual([
      { status: 'cancelled' },
    ]);

    const b = await createOrder([{ inventory_item_id: importedVariantItem, quantity: 1 }]);
    await call(seller, 'confirm_order', b);
    const soId = await scalar<string>(
      supplier,
      "select id from public.supplier_orders where status = 'pending'",
    );
    await scalar(supplier, "select public.ship_supplier_order($1, 'Jadlog', 'JD12345')", [soId]);
    await expect(call(seller, 'cancel_order', b)).rejects.toThrow(
      /orders.supplier_already_shipped/,
    );
  });

  it('anúncio despublicado antes da confirmação bloqueia o pedido', async () => {
    const id = await createOrder([{ inventory_item_id: importedVariantItem, quantity: 1 }]);
    await scalar(
      supplier,
      'update public.catalog_listings set is_published = false where id = $1',
      [listing],
    );
    await expect(call(seller, 'confirm_order', id)).rejects.toThrow(/orders.source_unavailable/);
    expect(await stock(supplierVariantItem)).toEqual({ on_hand: 5, reserved: 0 });
  });
});

describe('pedidos: isolamento', () => {
  it('outra organização não vê nem movimenta pedidos', async () => {
    const id = await createOrder([{ inventory_item_id: ownItem, quantity: 1 }]);
    expect(await rows(outsider, 'select 1 from public.orders')).toEqual([]);
    for (const fn of ['confirm_order', 'cancel_order', 'ship_order', 'deliver_order']) {
      await expect(call(outsider, fn, id)).rejects.toThrow(/orders.not_found/);
    }
    await expect(call(sellerMember, 'confirm_order', id)).rejects.toThrow(/orders.not_found/);
    expect(await rows(sellerMember, 'select number from public.orders')).toEqual([{ number: 1 }]);
  });
});
