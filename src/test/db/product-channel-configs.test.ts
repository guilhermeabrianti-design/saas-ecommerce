// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerMember: string;
let outsider: string;
let supplier: string;
let sellerOrg: string;
let supplierOrg: string;
let product: string;
let supplierProduct: string;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

const save = (
  user: string,
  p: string,
  provider: string,
  over: Partial<{
    enabled: boolean;
    title: string;
    price: number;
    type: string;
    mcat: string | null;
    free: boolean;
  }> = {},
) =>
  scalar<string>(
    user,
    'select public.save_product_channel_config($1, $2, $3, $4, $5, $6, null, $7, $8)',
    [
      p,
      provider,
      over.enabled ?? true,
      over.title ?? 'Camiseta Azul Algodão',
      over.price ?? 8990,
      over.type ?? 'classico',
      over.mcat === undefined ? 'mlb1234' : over.mcat,
      over.free ?? true,
    ],
  );

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  sellerMember = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
  outsider = await signUpUser(db, 'outro@example.com', { full_name: 'Outro' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Forn',
    account_type: 'supplier',
  });
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  await scalar(outsider, "select public.create_organization('Loja W')");
  supplierOrg = await scalar(supplier, "select public.create_organization('Fábrica X')");
  const inv = await scalar<string>(
    seller,
    "select public.invite_member($1, 'membro@example.com', 'member')",
    [sellerOrg],
  );
  await scalar(sellerMember, 'select public.accept_invitation($1)', [inv]);
  product = await scalar<string>(
    seller,
    "insert into public.products (organization_id, sku, name, price_cents) values ($1, 'CAM', 'Camiseta', 8990) returning id",
    [sellerOrg],
  );
  supplierProduct = await scalar<string>(
    supplier,
    "insert into public.products (organization_id, sku, name, price_cents) values ($1, 'CAM', 'Camiseta', 5000) returning id",
    [supplierOrg],
  );
});

afterEach(async () => {
  await db.close();
});

describe('configuração por canal', () => {
  it('vendedor salva e atualiza um canal; membros leem, outras lojas não', async () => {
    const id = await save(seller, product, 'mercadolivre');
    expect(await save(seller, product, 'mercadolivre', { price: 9990, type: 'premium' })).toBe(id);
    const row = await asUser(
      db,
      sellerMember,
      async (tx) =>
        (
          await tx.query(
            'select provider, title, price_cents, listing_type, marketplace_category, free_shipping from public.product_channel_configs',
          )
        ).rows,
    );
    expect(row).toEqual([
      {
        provider: 'mercadolivre',
        title: 'Camiseta Azul Algodão',
        price_cents: 9990,
        listing_type: 'premium',
        marketplace_category: 'MLB1234',
        free_shipping: true,
      },
    ]);
    expect(
      await asUser(
        db,
        outsider,
        async (tx) => (await tx.query('select id from public.product_channel_configs')).rows,
      ),
    ).toEqual([]);
  });

  it('título no limite de cada canal; tipo de anúncio precisa de taxa ativa', async () => {
    await expect(save(seller, product, 'mercadolivre', { title: 'x'.repeat(61) })).rejects.toThrow(
      /channels.title_too_long/,
    );
    await expect(
      save(seller, product, 'tiktok', { title: 'x'.repeat(200), type: 'padrao' }),
    ).resolves.toBeTruthy();
    await expect(save(seller, product, 'mercadolivre', { type: 'inventado' })).rejects.toThrow(
      /channels.listing_type_unavailable/,
    );
    // Shopee só tem taxa de live cadastrada; tipo comum ainda não.
    await expect(save(seller, product, 'shopee', { type: 'classico' })).rejects.toThrow(
      /channels.listing_type_unavailable/,
    );
    await expect(save(seller, product, 'mercadolivre', { price: 0 })).rejects.toThrow(
      /channels.invalid/,
    );
    await expect(save(seller, product, 'mercadolivre', { mcat: 'MLB 12' })).rejects.toThrow(
      /check/,
    );
  });

  it('só owner/admin do vendedor; fornecedor e canais removidos ficam de fora', async () => {
    await expect(save(sellerMember, product, 'mercadolivre')).rejects.toThrow(/products.not_found/);
    await expect(save(outsider, product, 'mercadolivre')).rejects.toThrow(/products.not_found/);
    await expect(save(supplier, supplierProduct, 'mercadolivre')).rejects.toThrow(
      /channels.sellers_only/,
    );
    await expect(save(seller, product, 'shopify')).rejects.toThrow(/channels.invalid/);
  });

  it('apagar o produto apaga as configurações', async () => {
    await save(seller, product, 'mercadolivre');
    await db.query('delete from public.products where id = $1', [product]);
    expect(
      (await db.query('select count(*)::int as n from public.product_channel_configs')).rows,
    ).toEqual([{ n: 0 }]);
  });
});
