// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { approveCatalog, asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let supplier: string; // owner of supplier org
let supplier2: string; // owner of another supplier org
let seller: string; // owner of seller org
let sellerMember: string; // plain member of seller org
let supplierOrg: string;
let supplier2Org: string;
let sellerOrg: string;
let product: string;
let listing: string;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

async function rows<T>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, userId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

const newProduct = (userId: string, orgId: string, sku: string, status = 'active') =>
  scalar<string>(
    userId,
    `insert into public.products (organization_id, sku, name, price_cents, cost_cents, status)
     values ($1, $2, 'Camiseta Premium', 9990, 1234, $3) returning id`,
    [orgId, sku, status],
  );

/** Publica e aprova (a moderação da Fase 16 tem testes próprios). */
async function publish(userId: string, orgId: string, productId: string, published = true) {
  const id = await scalar<string>(
    userId,
    `insert into public.catalog_listings (organization_id, product_id, wholesale_price_cents, suggested_price_cents, is_published)
     values ($1, $2, 3000, 7990, $3) returning id`,
    [orgId, productId, published],
  );
  await approveCatalog(db);
  return id;
}

const search = (userId: string, q = '') =>
  rows<{ listing_id: string; name: string; supplier_name: string; available: number }>(
    userId,
    'select * from public.search_catalog($1, 24, 0)',
    [q],
  );

const importListing = (userId: string, orgId: string, listingId: string, prefix = '') =>
  scalar<string>(userId, 'select public.import_catalog_listing($1, $2, $3)', [
    orgId,
    listingId,
    prefix,
  ]);

beforeEach(async () => {
  db = await createTestDatabase();
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Forn',
    account_type: 'supplier',
  });
  supplier2 = await signUpUser(db, 'forn2@example.com', {
    full_name: 'Forn 2',
    account_type: 'supplier',
  });
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vend' });
  sellerMember = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
  supplierOrg = await scalar(supplier, "select public.create_organization('Fábrica X')");
  supplier2Org = await scalar(supplier2, "select public.create_organization('Fábrica Y')");
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  const inv = await scalar<string>(
    seller,
    "select public.invite_member($1, 'membro@example.com', 'member')",
    [sellerOrg],
  );
  await scalar(sellerMember, 'select public.accept_invitation($1)', [inv]);

  product = await newProduct(supplier, supplierOrg, 'CP-01');
  listing = await publish(supplier, supplierOrg, product);
});

afterEach(async () => {
  await db.close();
});

describe('catálogo: publicação', () => {
  it('organização vendedora não publica no catálogo', async () => {
    const own = await newProduct(seller, sellerOrg, 'MEU-1');
    await expect(publish(seller, sellerOrg, own)).rejects.toThrow(/row-level security/);
  });

  it('fornecedor não publica produto de outra organização', async () => {
    await expect(publish(supplier2, supplier2Org, product)).rejects.toThrow(/foreign key/);
    await expect(publish(supplier2, supplierOrg, product)).rejects.toThrow(/row-level security/);
  });

  it('vendedor não lê a tabela de anúncios nem os produtos do fornecedor', async () => {
    expect(await rows(seller, 'select 1 from public.catalog_listings')).toEqual([]);
    expect(await rows(seller, 'select 1 from public.products where id = $1', [product])).toEqual(
      [],
    );
  });
});

describe('catálogo: consulta', () => {
  it('vendedor encontra só anúncios publicados de produtos ativos', async () => {
    await publish(supplier, supplierOrg, await newProduct(supplier, supplierOrg, 'RASC', 'draft'));
    await publish(supplier, supplierOrg, await newProduct(supplier, supplierOrg, 'OCULTO'), false);
    const found = await search(seller);
    expect(found.map((r) => r.listing_id)).toEqual([listing]);
    expect(found[0]).toMatchObject({ supplier_name: 'Fábrica X', name: 'Camiseta Premium' });
  });

  it('membro comum do vendedor também consulta; fornecedores e anon não', async () => {
    expect(await search(sellerMember)).toHaveLength(1);
    await expect(search(supplier2)).rejects.toThrow(/catalog.sellers_only/);
    await expect(scalar(null, "select * from public.search_catalog('', 24, 0)")).rejects.toThrow(
      /permission denied/,
    );
  });

  it('detalhe não expõe custo nem dados internos do fornecedor', async () => {
    const detail = await scalar<Record<string, unknown>>(
      seller,
      'select public.get_catalog_listing($1)',
      [listing],
    );
    expect(detail).toMatchObject({
      name: 'Camiseta Premium',
      wholesale_price_cents: 3000,
      suggested_price_cents: 7990,
    });
    const json = JSON.stringify(detail);
    for (const secret of ['cost_cents', '1234', 'created_by', supplier, supplierOrg, product]) {
      expect(json).not.toContain(secret);
    }
  });

  it('anúncio despublicado some da consulta e do detalhe', async () => {
    await scalar(
      supplier,
      'update public.catalog_listings set is_published = false where id = $1',
      [listing],
    );
    expect(await search(seller)).toEqual([]);
    await expect(
      scalar(seller, 'select public.get_catalog_listing($1)', [listing]),
    ).rejects.toThrow(/catalog.listing_not_found/);
  });

  it('mostra disponibilidade agregada do fornecedor', async () => {
    const item = await scalar<string>(
      supplier,
      'select id from public.inventory_items where product_id = $1',
      [product],
    );
    await scalar(
      supplier,
      "select public.adjust_stock($1, 7, 'purchase', null, gen_random_uuid())",
      [item],
    );
    expect((await search(seller))[0]?.available).toBe(7);
  });
});

describe('catálogo: importação', () => {
  it('cria produto rascunho do vendedor com variações e vínculo à origem', async () => {
    const v = await scalar<string>(
      supplier,
      `insert into public.product_variants (organization_id, product_id, sku, attributes)
       values ($1, $2, 'CP-01-AZ', '{"Cor":"Azul"}') returning id`,
      [supplierOrg, product],
    );
    await scalar(
      supplier,
      `insert into public.product_variants (organization_id, product_id, sku, attributes, is_active)
       values ($1, $2, 'CP-01-OFF', '{"Cor":"Preto"}', false)`,
      [supplierOrg, product],
    );

    const mine = await importListing(seller, sellerOrg, listing, 'FX-');
    const p = await db.query<Record<string, unknown>>(
      'select organization_id, sku, status, price_cents, cost_cents, source_listing_id, created_by from public.products where id = $1',
      [mine],
    );
    expect(p.rows[0]).toEqual({
      organization_id: sellerOrg,
      sku: 'FX-CP-01',
      status: 'draft',
      price_cents: 7990,
      cost_cents: 3000,
      source_listing_id: listing,
      created_by: seller,
    });
    const vars = await db.query<{ sku: string; source_variant_id: string }>(
      'select sku, source_variant_id from public.product_variants where product_id = $1',
      [mine],
    );
    expect(vars.rows).toEqual([{ sku: 'FX-CP-01-AZ', source_variant_id: v }]);
    // Inventory balance comes along automatically, starting at zero.
    const inv = await db.query('select 1 from public.inventory_items where product_id = $1', [
      mine,
    ]);
    expect(inv.rows.length).toBeGreaterThan(0);
  });

  it('não importa o mesmo anúncio duas vezes na mesma organização', async () => {
    await importListing(seller, sellerOrg, listing, 'A-');
    await expect(importListing(seller, sellerOrg, listing, 'B-')).rejects.toThrow(
      /catalog.already_imported/,
    );
  });

  it('SKU já usado pelo vendedor gera erro claro (use um prefixo)', async () => {
    await newProduct(seller, sellerOrg, 'CP-01');
    await expect(importListing(seller, sellerOrg, listing)).rejects.toThrow(/products.sku_taken/);
    await expect(importListing(seller, sellerOrg, listing, 'FX-')).resolves.toBeTruthy();
  });

  it('só owner/admin do vendedor importam, e só para a própria organização', async () => {
    await expect(importListing(sellerMember, sellerOrg, listing)).rejects.toThrow(/org.forbidden/);
    await expect(importListing(supplier, supplierOrg, listing)).rejects.toThrow(
      /catalog.sellers_only/,
    );
    const otherSeller = await signUpUser(db, 'v2@example.com', { full_name: 'V2' });
    await scalar(otherSeller, "select public.create_organization('Loja W')");
    await expect(importListing(otherSeller, sellerOrg, listing)).rejects.toThrow(/org.forbidden/);
  });

  it('rejeita prefixo inválido e anúncio invisível', async () => {
    await expect(importListing(seller, sellerOrg, listing, 'com espaço')).rejects.toThrow(
      /catalog.invalid_prefix/,
    );
    const hidden = await publish(
      supplier,
      supplierOrg,
      await newProduct(supplier, supplierOrg, 'H'),
      false,
    );
    await expect(importListing(seller, sellerOrg, hidden)).rejects.toThrow(
      /catalog.listing_not_found/,
    );
  });

  it('vendedor não forja vínculo de origem pela API', async () => {
    await expect(
      scalar(
        seller,
        "insert into public.products (organization_id, sku, name, price_cents, source_listing_id) values ($1, 'X', 'Nome', 1, $2)",
        [sellerOrg, listing],
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('catálogo: imagens no storage', () => {
  const path = () => `${supplierOrg}/${product}/foto.webp`;

  beforeEach(async () => {
    await scalar(
      supplier,
      "insert into storage.objects (bucket_id, name) values ('product-images', $1)",
      [path()],
    );
  });

  const visible = (userId: string) =>
    rows(userId, "select name from storage.objects where bucket_id = 'product-images'");

  it('vendedor lê imagens de anúncios visíveis', async () => {
    expect(await visible(seller)).toEqual([{ name: path() }]);
  });

  it('imagens de anúncio despublicado ou de outro fornecedor não aparecem', async () => {
    expect(await visible(supplier2)).toEqual([]);
    await scalar(
      supplier,
      'update public.catalog_listings set is_published = false where id = $1',
      [listing],
    );
    expect(await visible(seller)).toEqual([]);
  });

  it('vendedor não envia nem apaga arquivos do fornecedor', async () => {
    await expect(
      scalar(
        seller,
        "insert into storage.objects (bucket_id, name) values ('product-images', $1)",
        [`${supplierOrg}/${product}/intruso.webp`],
      ),
    ).rejects.toThrow(/row-level security/);
    const deleted = await asUser(
      db,
      seller,
      async (tx) =>
        (await tx.query("delete from storage.objects where bucket_id = 'product-images'"))
          .affectedRows,
    );
    expect(deleted).toBe(0);
  });
});
