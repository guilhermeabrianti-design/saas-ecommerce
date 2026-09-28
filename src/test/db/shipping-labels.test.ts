// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { approveCatalog, asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let supplier: string;
let stranger: string;
let sellerOrg: string;
let supplierOrg: string;
let orderId: string;
let supplierOrderId: string;
let ownOrderId: string;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

const upload = (user: string, path: string) =>
  scalar(user, "insert into storage.objects (bucket_id, name) values ('shipping-labels', $1)", [
    path,
  ]);

const register = (
  user: string,
  opts: { so?: string | null; order?: string | null; path: string; tracking?: string | null },
) =>
  scalar<string>(user, 'select public.register_shipping_label($1, $2, $3, $4, $5, $6)', [
    opts.so ?? null,
    opts.order ?? null,
    opts.path,
    'etiqueta.pdf',
    'Correios',
    opts.tracking ?? null,
  ]);

const buyer = {
  customer_name: 'Maria Compradora',
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

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  stranger = await signUpUser(db, 'outro@example.com', { full_name: 'Outro' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Forn',
    account_type: 'supplier',
  });
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  await scalar(stranger, "select public.create_organization('Loja W')");
  supplierOrg = await scalar(supplier, "select public.create_organization('Fábrica X')");

  const sp = await scalar<string>(
    supplier,
    "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, 'CAM', 'Camiseta', 9000, 'active') returning id",
    [supplierOrg],
  );
  const item = await scalar<string>(
    supplier,
    'select id from public.inventory_items where product_id = $1',
    [sp],
  );
  await scalar(
    supplier,
    "select public.adjust_stock($1, 10, 'purchase', null, gen_random_uuid())",
    [item],
  );
  const listing = await scalar<string>(
    supplier,
    `insert into public.catalog_listings (organization_id, product_id, wholesale_price_cents, is_published)
     values ($1, $2, 2000, true) returning id`,
    [supplierOrg, sp],
  );
  await approveCatalog(db);
  const imported = await scalar<string>(
    seller,
    "select public.import_catalog_listing($1, $2, 'FX-')",
    [sellerOrg, listing],
  );
  await scalar(
    seller,
    "update public.products set status = 'active', price_cents = 5990 where id = $1",
    [imported],
  );
  const sellerItem = await scalar<string>(
    seller,
    'select id from public.inventory_items where product_id = $1',
    [imported],
  );
  orderId = await scalar<string>(seller, 'select public.create_order($1, $2, gen_random_uuid())', [
    sellerOrg,
    JSON.stringify({ ...buyer, items: [{ inventory_item_id: sellerItem, quantity: 1 }] }),
  ]);
  await scalar(seller, 'select public.confirm_order($1)', [orderId]);
  supplierOrderId = await scalar<string>(
    seller,
    'select id from public.supplier_orders where order_id = $1',
    [orderId],
  );

  const own = await scalar<string>(
    seller,
    "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, 'CANECA', 'Caneca', 3500, 'active') returning id",
    [sellerOrg],
  );
  const ownItem = await scalar<string>(
    seller,
    'select id from public.inventory_items where product_id = $1',
    [own],
  );
  await scalar(seller, "select public.adjust_stock($1, 5, 'purchase', null, gen_random_uuid())", [
    ownItem,
  ]);
  ownOrderId = await scalar<string>(
    seller,
    'select public.create_order($1, $2, gen_random_uuid())',
    [sellerOrg, JSON.stringify({ ...buyer, items: [{ inventory_item_id: ownItem, quantity: 1 }] })],
  );
  await db.exec('delete from public.notifications');
});

afterEach(async () => {
  await db.close();
});

describe('etiquetas', () => {
  it('vendedor anexa a etiqueta do marketplace ao fornecimento; fornecedor vê e é avisado', async () => {
    const path = `so-${supplierOrderId}/marketplace.pdf`;
    await upload(seller, path);
    await register(seller, { so: supplierOrderId, path, tracking: ' aa123456789br ' });

    const rows = await asUser(
      db,
      supplier,
      async (tx) =>
        (await tx.query('select file_name, carrier, tracking_code from public.shipping_labels'))
          .rows,
    );
    expect(rows).toEqual([
      { file_name: 'etiqueta.pdf', carrier: 'Correios', tracking_code: 'AA123456789BR' },
    ]);
    expect(
      await scalar(
        supplier,
        "select count(*)::int from storage.objects where bucket_id = 'shipping-labels'",
      ),
    ).toBe(1);
    expect(
      await scalar(
        supplier,
        "select title from public.notifications where kind = 'label.attached'",
      ),
    ).toMatch(/Etiqueta anexada ao fornecimento #/);
  });

  it('quem não participa do envio não lê, não envia arquivo nem registra', async () => {
    const path = `so-${supplierOrderId}/x.pdf`;
    await expect(upload(stranger, path)).rejects.toThrow(/row-level security/);
    await upload(seller, path);
    expect(
      await scalar(
        stranger,
        "select count(*)::int from storage.objects where bucket_id = 'shipping-labels'",
      ),
    ).toBe(0);
    await expect(register(stranger, { so: supplierOrderId, path })).rejects.toThrow(
      /labels.not_found/,
    );
    await expect(upload(seller, 'qualquer-pasta/x.pdf')).rejects.toThrow(/row-level security/);
    await expect(
      scalar(
        seller,
        "insert into public.shipping_labels (order_id, storage_path, file_name) values ($1, 'o-x/y', 'y')",
        [ownOrderId],
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('pedido de estoque próprio; arquivo precisa existir na pasta do envio; anular', async () => {
    const path = `o-${ownOrderId}/etiqueta.png`;
    await expect(register(seller, { order: ownOrderId, path })).rejects.toThrow(
      /labels.file_missing/,
    );
    await upload(seller, path);
    await expect(register(seller, { order: orderId, path })).rejects.toThrow(/labels.file_missing/);
    const id = await register(seller, { order: ownOrderId, path });
    await scalar(seller, 'select public.void_shipping_label($1)', [id]);
    expect(
      (await db.query('select voided_at is not null as voided from public.shipping_labels')).rows,
    ).toEqual([{ voided: true }]);
    // Fornecedor não enxerga pedido de estoque próprio do vendedor.
    expect(await scalar(supplier, 'select count(*)::int from public.shipping_labels')).toBe(0);
  });

  it('envio cancelado não recebe etiqueta', async () => {
    await scalar(seller, 'select public.cancel_order($1)', [orderId]);
    const path = `so-${supplierOrderId}/tarde.pdf`;
    await upload(seller, path);
    await expect(register(seller, { so: supplierOrderId, path })).rejects.toThrow(
      /labels.shipment_closed/,
    );
  });
});
