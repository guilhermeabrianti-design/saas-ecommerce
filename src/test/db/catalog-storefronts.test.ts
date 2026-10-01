// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let supplierA: string;
let supplierB: string;
let orgA: string;
let orgB: string;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

async function rows<T>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, userId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

async function publish(user: string, org: string, sku: string, name: string) {
  const p = await scalar<string>(
    user,
    "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, $2, $3, 5000, 'active') returning id",
    [org, sku, name],
  );
  return scalar<string>(
    user,
    `insert into public.catalog_listings (organization_id, product_id, wholesale_price_cents, is_published)
     values ($1, $2, 3000, true) returning id`,
    [org, p],
  );
}

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  supplierA = await signUpUser(db, 'a@example.com', { full_name: 'A', account_type: 'supplier' });
  supplierB = await signUpUser(db, 'b@example.com', { full_name: 'B', account_type: 'supplier' });
  await scalar(seller, "select public.create_organization('Loja V')");
  orgA = await scalar(supplierA, "select public.create_organization('Fábrica Alfa')");
  orgB = await scalar(supplierB, "select public.create_organization('Fábrica Beta')");
});

afterEach(async () => {
  await db.close();
});

describe('vitrine de fornecedores', () => {
  it('publicou, apareceu: sem aprovação, com lojas e filtro por loja', async () => {
    const a1 = await publish(supplierA, orgA, 'A1', 'Smartwatch D20');
    await publish(supplierA, orgA, 'A2', 'Fone Bluetooth');
    const b1 = await publish(supplierB, orgB, 'B1', 'Caneca Térmica');

    const all = await rows<{ listing_id: string; supplier_id: string; supplier_name: string }>(
      seller,
      'select listing_id, supplier_id, supplier_name from public.catalog_browse(null, null, 24, 0)',
    );
    expect(all).toHaveLength(3);
    expect(all.every((r) => /^Fornecedor [0-9A-F]{6}$/.test(r.supplier_name))).toBe(true);
    expect(JSON.stringify(all)).not.toMatch(/Alfa|Beta/);

    const stores = await rows<{ supplier_id: string; listings: number; supplier_name: string }>(
      seller,
      'select supplier_id, listings, supplier_name from public.catalog_suppliers(24, 0)',
    );
    expect(stores.map((s) => [s.supplier_id, s.listings])).toEqual([
      [orgA, 2],
      [orgB, 1],
    ]);

    const onlyB = await rows<{ listing_id: string }>(
      seller,
      'select listing_id from public.catalog_browse(null, $1, 24, 0)',
      [orgB],
    );
    expect(onlyB).toEqual([{ listing_id: b1 }]);
    // Busca pelo apelido da loja funciona; pelo nome real, não.
    const alias = stores.find((s) => s.supplier_id === orgA)!.supplier_name;
    expect(
      (await rows(seller, 'select 1 from public.catalog_browse($1, null, 24, 0)', [alias])).length,
    ).toBe(2);
    expect(await rows(seller, "select 1 from public.catalog_browse('Alfa', null, 24, 0)")).toEqual(
      [],
    );
    expect(
      await rows(seller, "select listing_id from public.catalog_browse('smartwatch', null, 24, 0)"),
    ).toEqual([{ listing_id: a1 }]);
  });

  it('só vendedores navegam; despublicado ou bloqueado some', async () => {
    const a1 = await publish(supplierA, orgA, 'A1', 'Smartwatch D20');
    await expect(
      scalar(supplierB, 'select count(*) from public.catalog_browse(null, null, 24, 0)'),
    ).rejects.toThrow(/catalog.sellers_only/);
    await expect(
      scalar(supplierB, 'select count(*) from public.catalog_suppliers(24, 0)'),
    ).rejects.toThrow(/catalog.sellers_only/);

    await db.query(
      "update public.catalog_listings set moderation_status = 'blocked' where id = $1",
      [a1],
    );
    expect(await rows(seller, 'select 1 from public.catalog_browse(null, null, 24, 0)')).toEqual(
      [],
    );
    expect(await rows(seller, 'select 1 from public.catalog_suppliers(24, 0)')).toEqual([]);
  });
});
