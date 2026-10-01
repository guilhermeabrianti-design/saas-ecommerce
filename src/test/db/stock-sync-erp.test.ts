// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { approveCatalog, asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerMember: string;
let supplier: string;
let sellerOrg: string;
let supplierOrg: string;
let caneca: string;

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

const onHand = async (item: string) =>
  (
    await db.query<{ on_hand: number; reserved: number }>(
      'select on_hand, reserved from public.inventory_items where id = $1',
      [item],
    )
  ).rows[0]!;

async function product(user: string, org: string, sku: string, qty: number) {
  const p = await scalar<string>(
    user,
    "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, $2, $2, 5000, 'active') returning id",
    [org, sku],
  );
  const item = await scalar<string>(
    user,
    'select id from public.inventory_items where product_id = $1',
    [p],
  );
  if (qty > 0) {
    await scalar(user, "select public.adjust_stock($1, $2, 'purchase', null, gen_random_uuid())", [
      item,
      qty,
    ]);
  }
  return { product: p, item };
}

const bulk = (user: string, org: string, rows: unknown) =>
  scalar<Record<string, unknown>>(user, 'select public.bulk_set_stock($1, $2)', [
    org,
    JSON.stringify(rows),
  ]);

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  sellerMember = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Forn',
    account_type: 'supplier',
  });
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  supplierOrg = await scalar(supplier, "select public.create_organization('Fábrica X')");
  const inv = await scalar<string>(
    seller,
    "select public.invite_member($1, 'membro@example.com', 'member')",
    [sellerOrg],
  );
  await scalar(sellerMember, 'select public.accept_invitation($1)', [inv]);
  caneca = (await product(seller, sellerOrg, 'CANECA', 150)).item;
});

afterEach(async () => {
  await db.close();
});

describe('estoque por planilha', () => {
  it('define o saldo pelo SKU, registra como contagem e resume o que não bateu', async () => {
    const summary = await bulk(seller, sellerOrg, [
      { sku: 'caneca', quantity: '149' },
      { sku: 'NAO-EXISTE', quantity: '3' },
      { sku: 'CANECA', quantity: 'abc' },
      { sku: '', quantity: '1' },
    ]);
    // Repetido: vale a última linha (inválida) → nada muda para CANECA.
    expect(summary).toMatchObject({ updated: 0, unknown: ['NAO-EXISTE'], invalid: ['CANECA'] });

    expect(await bulk(seller, sellerOrg, [{ sku: 'caneca', quantity: '149' }])).toMatchObject({
      updated: 1,
      unchanged: 0,
    });
    expect(await onHand(caneca)).toEqual({ on_hand: 149, reserved: 0 });
    expect(
      (
        await db.query(
          "select quantity_delta, reason, note from public.inventory_movements where item_id = $1 and reason = 'count'",
          [caneca],
        )
      ).rows,
    ).toEqual([{ quantity_delta: -1, reason: 'count', note: 'Planilha' }]);
    expect(await bulk(seller, sellerOrg, [{ sku: 'CANECA', quantity: '149' }])).toMatchObject({
      updated: 0,
      unchanged: 1,
    });
  });

  it('não desce abaixo do reservado; dropshipping fica de fora; só owner/admin', async () => {
    await db.query('update public.inventory_items set reserved = 10 where id = $1', [caneca]);
    expect(await bulk(seller, sellerOrg, [{ sku: 'CANECA', quantity: '4' }])).toMatchObject({
      clamped: ['CANECA'],
    });
    expect(await onHand(caneca)).toEqual({ on_hand: 10, reserved: 10 });

    // Produto importado do catálogo usa o estoque do fornecedor.
    const sp = await product(supplier, supplierOrg, 'CAM', 5);
    const listing = await scalar<string>(
      supplier,
      `insert into public.catalog_listings (organization_id, product_id, wholesale_price_cents, is_published)
       values ($1, $2, 2000, true) returning id`,
      [supplierOrg, sp.product],
    );
    await approveCatalog(db);
    await scalar(seller, "select public.import_catalog_listing($1, $2, 'FX-')", [
      sellerOrg,
      listing,
    ]);
    expect(await bulk(seller, sellerOrg, [{ sku: 'FX-CAM', quantity: '50' }])).toMatchObject({
      unknown: ['FX-CAM'],
    });

    await expect(bulk(sellerMember, sellerOrg, [])).rejects.toThrow(/org.forbidden/);
    await expect(bulk(supplier, sellerOrg, [])).rejects.toThrow(/org.forbidden/);
    // Fornecedor também atualiza o próprio estoque.
    expect(await bulk(supplier, supplierOrg, [{ sku: 'CAM', quantity: '7' }])).toMatchObject({
      updated: 1,
    });
    await expect(bulk(seller, sellerOrg, { sku: 'x' })).rejects.toThrow(/stock.invalid_rows/);
  });
});

describe('ERP (Bling / Tiny)', () => {
  it('conexão por empresa; agendamento lê os SKUs e aplica os saldos com cursor', async () => {
    const conn = await service<string>(
      "select public.erp_upsert_connection($1, $2, 'tiny', 'Meu Tiny')",
      [sellerOrg, seller],
    );
    expect(
      await service<string>("select public.erp_upsert_connection($1, $2, 'tiny', 'Tiny 2')", [
        sellerOrg,
        seller,
      ]),
    ).toBe(conn);
    await expect(
      service("select public.erp_upsert_connection($1, $2, 'tiny', 'Tiny X')", [
        sellerOrg,
        sellerMember,
      ]),
    ).rejects.toThrow(/org.forbidden/);

    expect(
      (await db.query('select connection_id, provider from public.erp_due_connections(10)')).rows,
    ).toEqual([{ connection_id: conn, provider: 'tiny' }]);
    expect((await db.query('select sku from public.erp_skus($1)', [conn])).rows).toEqual([
      { sku: 'CANECA' },
    ]);

    const summary = await service<Record<string, unknown>>(
      "select public.erp_apply_stock($1, $2, '01/10/2026 12:00:00')",
      [
        conn,
        JSON.stringify([
          { sku: 'CANECA', quantity: 149 },
          { sku: 'SO-NO-ERP', quantity: 2 },
        ]),
      ],
    );
    expect(summary).toMatchObject({ updated: 1, unknown_count: 1 });
    expect(await onHand(caneca)).toEqual({ on_hand: 149, reserved: 0 });
    expect(
      (
        await db.query(
          'select sync_cursor, last_sync_summary is not null as has_summary from public.integration_connections where id = $1',
          [conn],
        )
      ).rows,
    ).toEqual([{ sync_cursor: '01/10/2026 12:00:00', has_summary: true }]);
    expect(
      (
        await db.query(
          "select status, message from public.integration_events where kind = 'stock.sync'",
        )
      ).rows,
    ).toEqual([
      { status: 'ok', message: '1 atualizado(s), 0 igual(is), 1 SKU(s) sem cadastro aqui' },
    ]);
    expect(
      (
        await db.query(
          "select note from public.inventory_movements where item_id = $1 and reason = 'count'",
          [caneca],
        )
      ).rows,
    ).toEqual([{ note: 'Sincronizado do Tiny' }]);
  });

  it('sincronizar agora: owner/admin da conexão; desconectada não sincroniza', async () => {
    const conn = await service<string>(
      "select public.erp_upsert_connection($1, $2, 'bling', 'Bling')",
      [sellerOrg, seller],
    );
    expect(await scalar(seller, 'select public.erp_sync_request($1)', [conn])).toBe('bling');
    await expect(
      scalar(sellerMember, 'select public.erp_sync_request($1)', [conn]),
    ).rejects.toThrow(/integrations.not_found/);
    await expect(scalar(supplier, 'select public.erp_sync_request($1)', [conn])).rejects.toThrow(
      /integrations.not_found/,
    );
    await scalar(seller, "select public.set_connection_status($1, 'disconnected')", [conn]);
    await expect(scalar(seller, 'select public.erp_sync_request($1)', [conn])).rejects.toThrow(
      /integrations.disconnected/,
    );
    expect(await service("select public.erp_apply_stock($1, '[]'::jsonb, null)", [conn])).toEqual({
      status: 'inactive',
    });
    // Bling pelo OAuth vale para fornecedor; Mercado Livre continua só vendedor.
    await expect(
      scalar(supplier, "select public.oauth_begin($1, 'bling', 'Bling', $2)", [
        supplierOrg,
        'a'.repeat(43),
      ]),
    ).resolves.toBeTruthy();
    await expect(
      scalar(supplier, "select public.oauth_begin($1, 'mercadolivre', 'ML', $2)", [
        supplierOrg,
        'a'.repeat(43),
      ]),
    ).rejects.toThrow(/integrations.sellers_only/);
  });
});
