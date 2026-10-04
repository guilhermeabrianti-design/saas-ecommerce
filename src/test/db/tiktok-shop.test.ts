// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { approveCatalog, asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerMember: string;
let stranger: string;
let supplier: string;
let sellerOrg: string;
let supplierOrg: string;
let connection: string;
let item: string;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

async function service<T>(sql: string, params: unknown[] = []): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec('set local role service_role');
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

const rows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

const OID = '576461413038785752';
const PKG = '1152921504';

const tiktokOrder = {
  customer_name: 'Maria Silva',
  ship_postal_code: '01310100',
  ship_street: 'Av. Paulista',
  ship_number: '1000',
  ship_district: 'Bela Vista',
  ship_city: 'São Paulo',
  ship_state: 'SP',
  shipping_cents: 0,
  discount_cents: 0,
  notes: `TikTok Shop #${OID}`,
  items: [{ external_item_id: 'FX-CAM', quantity: 1, unit_price_cents: 5990 }],
};

type Forward = {
  status: string;
  forwarded: boolean;
  order_id: string;
  supplier_order_id: string | null;
  target_order_id: string | null;
  existing: string[];
};

const putFile = (path: string) =>
  service("insert into storage.objects (bucket_id, name) values ('shipping-labels', $1)", [path]);

const connect = async (user: string, org: string, shopId: string) => {
  const state = await scalar<string>(
    user,
    "select public.oauth_begin($1, 'tiktok', 'Minha loja TikTok', $2)",
    [org, 'b'.repeat(43)],
  );
  const c = await service<{ organization_id: string; user_id: string; name: string }>(
    'select public.oauth_consume($1)',
    [state],
  );
  return service<string>("select public.oauth_complete($1, $2, 'tiktok', $3, $4, null, null)", [
    c.organization_id,
    c.user_id,
    c.name,
    shopId,
  ]);
};

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  sellerMember = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
  stranger = await signUpUser(db, 'outro@example.com', { full_name: 'Outro' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Forn',
    account_type: 'supplier',
  });
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  await scalar(stranger, "select public.create_organization('Loja W')");
  supplierOrg = await scalar(supplier, "select public.create_organization('Fábrica X')");
  const inv = await scalar<string>(
    seller,
    "select public.invite_member($1, 'membro@example.com', 'member')",
    [sellerOrg],
  );
  await scalar(sellerMember, 'select public.accept_invitation($1)', [inv]);

  const sp = await scalar<string>(
    supplier,
    "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, 'CAM', 'Camiseta', 9000, 'active') returning id",
    [supplierOrg],
  );
  const si = await scalar<string>(
    supplier,
    'select id from public.inventory_items where product_id = $1',
    [sp],
  );
  await scalar(
    supplier,
    "select public.adjust_stock($1, 10, 'purchase', null, gen_random_uuid())",
    [si],
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
  item = await scalar<string>(
    seller,
    'select id from public.inventory_items where product_id = $1',
    [imported],
  );

  connection = await connect(seller, sellerOrg, '7494061928453720000');
  await scalar(seller, "select public.link_listing($1, $2, 'FX-CAM')", [connection, item]);
  await db.exec('delete from public.notifications');
});

afterEach(async () => {
  await db.close();
});

describe('TikTok Shop', () => {
  it('só vendedor owner/admin conecta; loja em uma empresa por vez', async () => {
    await expect(
      scalar(supplier, "select public.oauth_begin($1, 'tiktok', 'Loja', $2)", [
        supplierOrg,
        'b'.repeat(43),
      ]),
    ).rejects.toThrow(/sellers_only/);
    expect(
      await service('select public.marketplace_connection($1, $2)', [
        'tiktok',
        '7494061928453720000',
      ]),
    ).toBe(connection);
    const strangerOrg = await scalar<string>(
      stranger,
      'select organization_id from public.organization_members where user_id = $1',
      [stranger],
    );
    await expect(connect(stranger, strangerOrg, '7494061928453720000')).rejects.toThrow(
      /account_in_use/,
    );
  });

  it('pedido vai ao fornecedor com a etiqueta do pacote', async () => {
    expect(
      await service('select public.ingest_marketplace_order($1, $2, $3)', [
        connection,
        OID,
        JSON.stringify(tiktokOrder),
      ]),
    ).toBe('created');
    const f = await service<Forward>('select public.marketplace_forward_order($1, $2)', [
      connection,
      OID,
    ]);
    expect(f).toMatchObject({ status: 'confirmed', forwarded: true, existing: [] });

    const path = `so-${f.supplier_order_id}/tiktok-label-${PKG}.pdf`;
    await putFile(path);
    expect(
      await service<string>(
        'select public.attach_marketplace_document($1, $2, $3, $4, $5, $6, $7, $8)',
        [f.order_id, 'label', path, 'etiqueta.pdf', PKG, 'BR999', 'tiktok', null],
      ),
    ).toBe('attached');
    expect(await rows('select source, carrier, tracking_code from public.shipping_labels')).toEqual(
      [{ source: 'tiktok', carrier: 'TikTok Shop', tracking_code: 'BR999' }],
    );
    expect(
      await rows("select title from public.notifications where kind = 'label.attached'"),
    ).toEqual([{ title: expect.stringMatching(/^Etiqueta da TikTok Shop no fornecimento #/) }]);
    expect(
      (await service<Forward>('select public.marketplace_forward_order($1, $2)', [connection, OID]))
        .existing,
    ).toEqual([`label:${PKG}`]);

    const orderId = f.order_id;
    expect(await scalar(sellerMember, 'select public.order_marketplace($1)', [orderId])).toBe(
      'tiktok',
    );
  });
});
