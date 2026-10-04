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

const SN = '240101ABCDEF12';

const shopeeOrder = {
  customer_name: 'Maria Silva',
  ship_postal_code: '01310100',
  ship_street: 'Av. Paulista',
  ship_number: '1000',
  ship_district: 'Bela Vista',
  ship_city: 'São Paulo',
  ship_state: 'SP',
  shipping_cents: 0,
  discount_cents: 0,
  notes: `Shopee #${SN}`,
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
    "select public.oauth_begin($1, 'shopee', 'Minha loja Shopee', $2)",
    [org, 'b'.repeat(43)],
  );
  const c = await service<{ organization_id: string; user_id: string; name: string }>(
    'select public.oauth_consume($1)',
    [state],
  );
  return service<string>("select public.oauth_complete($1, $2, 'shopee', $3, $4, null, null)", [
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

  connection = await connect(seller, sellerOrg, '880011');
  await scalar(seller, "select public.link_listing($1, $2, 'FX-CAM')", [connection, item]);
  await db.exec('delete from public.notifications');
});

afterEach(async () => {
  await db.close();
});

describe('conexão da Shopee', () => {
  it('só vendedor owner/admin começa; TikTok Shop ainda não', async () => {
    await expect(
      scalar(sellerMember, "select public.oauth_begin($1, 'shopee', 'Loja', $2)", [
        sellerOrg,
        'b'.repeat(43),
      ]),
    ).rejects.toThrow(/org.forbidden/);
    await expect(
      scalar(supplier, "select public.oauth_begin($1, 'shopee', 'Loja', $2)", [
        supplierOrg,
        'b'.repeat(43),
      ]),
    ).rejects.toThrow(/sellers_only/);
    await expect(
      scalar(seller, "select public.oauth_begin($1, 'tiktok', 'Loja', $2)", [
        sellerOrg,
        'b'.repeat(43),
      ]),
    ).rejects.toThrow(/provider_unavailable/);
  });

  it('loja ligada a uma empresa só; achada pela conta nas notificações', async () => {
    expect(
      await service('select public.marketplace_connection($1, $2)', ['shopee', '880011']),
    ).toBe(connection);
    expect(
      await service('select public.marketplace_connection($1, $2)', ['mercadolivre', '880011']),
    ).toBeNull();
    const strangerOrg = await scalar<string>(
      stranger,
      'select organization_id from public.organization_members where user_id = $1',
      [stranger],
    );
    await expect(connect(stranger, strangerOrg, '880011')).rejects.toThrow(/account_in_use/);

    await scalar(seller, "select public.set_connection_status($1, 'paused')", [connection]);
    expect(
      await service('select public.marketplace_connection($1, $2)', ['shopee', '880011']),
    ).toBeNull();
  });

  it('funções internas fechadas para a API', async () => {
    for (const sql of [
      "select public.marketplace_connection('shopee', '880011')",
      `select public.remember_listing_refs('${connection}', '[]')`,
      `select public.marketplace_forward_order('${connection}', '${SN}')`,
      'select * from public.claim_stock_sync(1)',
    ]) {
      await expect(scalar(seller, sql)).rejects.toThrow(/permission denied/);
    }
  });
});

describe('pedido e etiqueta da Shopee', () => {
  it('pedido pago vai ao fornecedor e a etiqueta da Shopee chega no fornecimento', async () => {
    expect(
      await service('select public.ingest_marketplace_order($1, $2, $3)', [
        connection,
        SN,
        JSON.stringify(shopeeOrder),
      ]),
    ).toBe('created');
    const f = await service<Forward>('select public.marketplace_forward_order($1, $2)', [
      connection,
      SN,
    ]);
    expect(f).toMatchObject({ status: 'confirmed', forwarded: true, existing: [] });
    expect(f.supplier_order_id).toBeTruthy();

    const path = `so-${f.supplier_order_id}/shopee-label-${SN}.pdf`;
    await putFile(path);
    const attach = () =>
      service<string>('select public.attach_marketplace_document($1, $2, $3, $4, $5, $6, $7, $8)', [
        f.order_id,
        'label',
        path,
        `etiqueta-shopee-${SN}.pdf`,
        SN,
        'br123456789',
        'shopee',
        null,
      ]);
    expect(await attach()).toBe('attached');
    expect(await attach()).toBe('duplicate');

    expect(
      await rows(
        'select source, carrier, tracking_code, supplier_order_id from public.shipping_labels',
      ),
    ).toEqual([
      {
        source: 'shopee',
        carrier: 'Shopee',
        tracking_code: 'BR123456789',
        supplier_order_id: f.supplier_order_id,
      },
    ]);
    expect(
      await rows(
        "select organization_id, title from public.notifications where kind = 'label.attached'",
      ),
    ).toEqual([
      {
        organization_id: supplierOrg,
        title: expect.stringMatching(/^Etiqueta da Shopee no fornecimento #/),
      },
    ]);
    expect(
      (await service<Forward>('select public.marketplace_forward_order($1, $2)', [connection, SN]))
        .existing,
    ).toEqual([`label:${SN}`]);
  });

  it('origem desconhecida é recusada', async () => {
    await service('select public.ingest_marketplace_order($1, $2, $3)', [
      connection,
      SN,
      JSON.stringify(shopeeOrder),
    ]);
    const f = await service<Forward>('select public.marketplace_forward_order($1, $2)', [
      connection,
      SN,
    ]);
    const path = `so-${f.supplier_order_id}/x.pdf`;
    await putFile(path);
    await expect(
      service('select public.attach_marketplace_document($1, $2, $3, $4, $5, $6, $7)', [
        f.order_id,
        'label',
        path,
        'x.pdf',
        SN,
        null,
        'amazon',
      ]),
    ).rejects.toThrow(/labels.invalid/);
  });

  it('botão do pedido: marketplace de origem e releitura só para quem é da loja', async () => {
    await service('select public.ingest_marketplace_order($1, $2, $3)', [
      connection,
      SN,
      JSON.stringify(shopeeOrder),
    ]);
    const orderId = await service<string>(
      'select order_id from public.external_orders where external_id = $1',
      [SN],
    );
    expect(await scalar(sellerMember, 'select public.order_marketplace($1)', [orderId])).toBe(
      'shopee',
    );
    expect(await scalar(stranger, 'select public.order_marketplace($1)', [orderId])).toBeNull();

    const req = (user: string, provider: string) =>
      asUser(
        db,
        user,
        async (tx) =>
          (
            await tx.query('select * from public.marketplace_documents_request($1, $2)', [
              orderId,
              provider,
            ])
          ).rows,
      );
    expect(await req(sellerMember, 'shopee')).toEqual([
      { connection_id: connection, external_id: SN, external_account_id: '880011' },
    ]);
    expect(await req(sellerMember, 'mercadolivre')).toEqual([]);
    await expect(req(stranger, 'shopee')).rejects.toThrow(/orders.not_found/);
  });
});

describe('referência do item para o estoque', () => {
  it('guarda a referência do SKU vinculado e a devolve ao worker', async () => {
    expect(
      await service<number>('select public.remember_listing_refs($1, $2)', [
        connection,
        JSON.stringify([
          { sku: 'FX-CAM', ref: '111:222' },
          { sku: 'SEM-VINCULO', ref: '1:0' },
          { sku: 'FX-CAM', ref: 'inválida!' },
        ]),
      ]),
    ).toBe(1);
    await expect(
      service('select public.remember_listing_refs($1, $2)', [connection, '{}']),
    ).rejects.toThrow(/integrations.invalid/);

    await db.exec(`update public.inventory_items set on_hand = on_hand + 1 where id = '${item}'`);
    const claimed = await db.transaction(async (tx) => {
      await tx.exec('set local role service_role');
      return (await tx.query('select * from public.claim_stock_sync(10)')).rows;
    });
    expect(claimed).toContainEqual(
      expect.objectContaining({
        provider: 'shopee',
        external_id: 'FX-CAM',
        external_account_id: '880011',
        external_ref: '111:222',
        link_id: expect.any(String),
      }),
    );

    // Trocar o SKU do vínculo esquece a referência.
    await db.exec(
      `update public.listing_links set external_id = 'FX-CAM-2' where connection_id = '${connection}'`,
    );
    expect(
      await rows('select external_ref from public.listing_links where connection_id = $1', [
        connection,
      ]),
    ).toEqual([{ external_ref: null }]);
  });
});
