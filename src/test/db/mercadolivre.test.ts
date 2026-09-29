// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { approveCatalog, asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerAdmin: string;
let sellerMember: string;
let other: string;
let supplier: string;
let sellerOrg: string;
let otherOrg: string;
let supplierOrg: string;

const verifier = 'a'.repeat(43);

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

const begin = (user: string, org: string) =>
  scalar<string>(user, "select public.oauth_begin($1, 'mercadolivre', 'Minha conta ML', $2)", [
    org,
    verifier,
  ]);

type Consumed = { organization_id: string; user_id: string; name: string; code_verifier: string };

const complete = (c: Consumed, account: string, version = 1) =>
  service<string>("select public.oauth_complete($1, $2, 'mercadolivre', $3, $4, $5, $6)", [
    c.organization_id,
    c.user_id,
    c.name,
    account,
    'cifrado-'.padEnd(40, 'x'),
    JSON.stringify({ token_version: version, expires_at: '2026-10-01T00:00:00Z' }),
  ]);

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  sellerAdmin = await signUpUser(db, 'adm@example.com', { full_name: 'Admin' });
  sellerMember = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
  other = await signUpUser(db, 'outra@example.com', { full_name: 'Outra' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Forn',
    account_type: 'supplier',
  });
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  otherOrg = await scalar(other, "select public.create_organization('Loja W')");
  supplierOrg = await scalar(supplier, "select public.create_organization('Fábrica X')");
  for (const [user, email, role] of [
    [sellerAdmin, 'adm@example.com', 'admin'],
    [sellerMember, 'membro@example.com', 'member'],
  ] as const) {
    const inv = await scalar<string>(seller, 'select public.invite_member($1, $2, $3)', [
      sellerOrg,
      email,
      role,
    ]);
    await scalar(user, 'select public.accept_invitation($1)', [inv]);
  }
});

afterEach(async () => {
  await db.close();
});

describe('OAuth do Mercado Livre', () => {
  it('começa (owner/admin), consome uma vez e cria a conexão com credenciais cifradas', async () => {
    const state = await begin(sellerAdmin, sellerOrg);
    const consumed = await service<Consumed>('select public.oauth_consume($1)', [state]);
    expect(consumed).toMatchObject({
      organization_id: sellerOrg,
      user_id: sellerAdmin,
      code_verifier: verifier,
    });
    await expect(service('select public.oauth_consume($1)', [state])).rejects.toThrow(
      /integrations.oauth_state_invalid/,
    );

    const id = await complete(consumed, '123456789');
    expect(
      (
        await db.query(
          'select provider, external_account_id, status from public.integration_connections where id = $1',
          [id],
        )
      ).rows[0],
    ).toEqual({ provider: 'mercadolivre', external_account_id: '123456789', status: 'active' });
    expect(await service('select public.mercadolivre_connection($1)', ['123456789'])).toBe(id);

    // Reconectar a mesma conta na mesma loja reaproveita a conexão.
    await scalar(seller, "select public.set_connection_status($1, 'paused')", [id]);
    const again = await service<Consumed>('select public.oauth_consume($1)', [
      await begin(seller, sellerOrg),
    ]);
    expect(await complete(again, '123456789')).toBe(id);
    expect(
      (await db.query('select status from public.integration_connections where id = $1', [id]))
        .rows[0],
    ).toEqual({ status: 'active' });
  });

  it('recusa membro, fornecedor, estado vencido e conta já ligada a outra loja', async () => {
    await expect(begin(sellerMember, sellerOrg)).rejects.toThrow(/org.forbidden/);
    await expect(begin(supplier, supplierOrg)).rejects.toThrow(/integrations.sellers_only/);
    await expect(
      scalar(seller, "select public.oauth_begin($1, 'mercadolivre', 'X', 'curto')", [sellerOrg]),
    ).rejects.toThrow(/integrations.invalid/);

    const old = await begin(seller, sellerOrg);
    await db.query(
      "update public.oauth_states set created_at = now() - interval '11 minutes' where state = $1",
      [old],
    );
    await expect(service('select public.oauth_consume($1)', [old])).rejects.toThrow(
      /integrations.oauth_state_invalid/,
    );

    const mine = await service<Consumed>('select public.oauth_consume($1)', [
      await begin(seller, sellerOrg),
    ]);
    await complete(mine, '555');
    const theirs = await service<Consumed>('select public.oauth_consume($1)', [
      await begin(other, otherOrg),
    ]);
    await expect(complete(theirs, '555')).rejects.toThrow(/integrations.account_in_use/);

    // Contas conectadas não chamam as funções do service role nem leem os estados.
    await expect(scalar(seller, 'select public.oauth_consume(gen_random_uuid())')).rejects.toThrow(
      /permission denied/,
    );
    await expect(scalar(seller, 'select count(*) from public.oauth_states')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('renovação de token grava só na versão esperada (sem atropelo)', async () => {
    const c = await service<Consumed>('select public.oauth_consume($1)', [
      await begin(seller, sellerOrg),
    ]);
    const id = await complete(c, '777', 1);
    const swap = (expected: number, next: number) =>
      service<boolean>('select public.swap_connection_credentials($1, $2, $3, $4)', [
        id,
        expected,
        'novo-cifrado'.padEnd(40, 'y'),
        JSON.stringify({ token_version: next }),
      ]);
    expect(await swap(1, 2)).toBe(true);
    expect(await swap(1, 2)).toBe(false);
    expect(await swap(2, 3)).toBe(true);
  });
});

describe('vínculo manual de SKU com produto importado', () => {
  it('aceita item de dropshipping e enfileira o estoque do fornecedor', async () => {
    const c = await service<Consumed>('select public.oauth_consume($1)', [
      await begin(seller, sellerOrg),
    ]);
    const connection = await complete(c, '888');

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
      "select public.adjust_stock($1, 12, 'purchase', null, gen_random_uuid())",
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
    const item = await scalar<string>(
      seller,
      'select id from public.inventory_items where product_id = $1',
      [imported],
    );

    await scalar(seller, "select public.link_listing($1, $2, 'FX-CAM')", [connection, item]);
    expect(
      (await db.query('select available from public.stock_sync_outbox where done_at is null')).rows,
    ).toEqual([{ available: 12 }]);
  });
});
