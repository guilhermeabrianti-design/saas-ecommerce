// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, connectMarketplace, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerMember: string;
let sellerOrg: string;
let product: string;
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

/** Tipos de anúncio com taxa já cadastrada: Shopee "live", TikTok Shop "padrao". */
const listingType = { shopee: 'live', tiktok: 'padrao' } as const;

const saveConfig = (provider: 'shopee' | 'tiktok', mcat: string | null = '100017') =>
  scalar<string>(
    seller,
    "select public.save_product_channel_config($1, $2, true, 'Camiseta Azul', 5990, $3, null, $4, false)",
    [product, provider, listingType[provider], mcat],
  );

type Begun = {
  run_id: string;
  provider: string;
  connection_id: string;
  account_id: string;
  external_id: string | null;
  product: Record<string, unknown>;
  images: string[];
};

const begin = (user: string, provider: string, action = 'publish') =>
  scalar<Begun>(user, 'select public.marketplace_publish_begin($1, $2, $3)', [
    product,
    provider,
    action,
  ]);

const finish = (run: string, ok: boolean, over: Record<string, unknown> = {}) =>
  service<boolean>('select public.marketplace_publish_finish($1, $2, $3, $4, $5, $6, $7)', [
    run,
    ok,
    over.id ?? null,
    over.url ?? null,
    over.status ?? (ok ? 'active' : null),
    over.error ?? null,
    JSON.stringify(over.links ?? []),
  ]);

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  sellerMember = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  const inv = await scalar<string>(
    seller,
    "select public.invite_member($1, 'membro@example.com', 'member')",
    [sellerOrg],
  );
  await scalar(sellerMember, 'select public.accept_invitation($1)', [inv]);
  product = await scalar<string>(
    seller,
    "insert into public.products (organization_id, sku, name, description, price_cents, status, weight_grams) values ($1, 'CAM', 'Camiseta', 'Algodão', 5990, 'active', 250) returning id",
    [sellerOrg],
  );
  item = await scalar<string>(
    seller,
    'select id from public.inventory_items where product_id = $1',
    [product],
  );
  await db.query(
    "insert into public.product_images (organization_id, product_id, storage_path) values ($1::uuid, $2::uuid, $1::text || '/' || $2::text || '/foto.jpg')",
    [sellerOrg, product],
  );
});

afterEach(async () => {
  await db.close();
});

describe('publicar na Shopee e na TikTok Shop', () => {
  it('pede canal salvo, categoria e loja conectada; devolve a loja', async () => {
    await expect(begin(seller, 'shopee')).rejects.toThrow(/channels.save_first/);
    await saveConfig('shopee', null);
    await expect(begin(seller, 'shopee')).rejects.toThrow(/publish.category_required/);
    await saveConfig('shopee');
    await expect(begin(seller, 'shopee')).rejects.toThrow(/publish.not_connected/);
    await expect(begin(sellerMember, 'shopee')).rejects.toThrow(/products.not_found/);
    await expect(begin(seller, 'amazon')).rejects.toThrow(/publish.invalid_action/);

    const conn = await connectMarketplace(db, seller, sellerOrg, 'shopee', '880011');
    const b = await begin(seller, 'shopee');
    expect(b).toMatchObject({
      provider: 'shopee',
      connection_id: conn,
      account_id: '880011',
      external_id: null,
      product: { sku: 'CAM', weight_grams: 250, available: 0 },
    });
    expect(b.images).toHaveLength(1);
    await expect(begin(seller, 'shopee')).rejects.toThrow(/publish.busy/);
  });

  it('conclui com estado "em análise", vínculo com a referência e pontos', async () => {
    await saveConfig('tiktok', '601226');
    await connectMarketplace(db, seller, sellerOrg, 'tiktok', '7494061928453720000');
    const b = await begin(seller, 'tiktok');
    expect(
      await finish(b.run_id, true, {
        id: '1729',
        status: 'review',
        links: [{ inventory_item_id: item, sku: 'CAM', ref: '1729:900:7068' }],
      }),
    ).toBe(true);
    expect(await finish(b.run_id, true, { id: '1729' })).toBe(false);

    expect(
      await rows(
        "select publish_status, external_id from public.product_channel_configs where provider = 'tiktok'",
      ),
    ).toEqual([{ publish_status: 'review', external_id: '1729' }]);
    expect(await rows('select external_id, external_ref from public.listing_links')).toEqual([
      { external_id: 'CAM', external_ref: '1729:900:7068' },
    ]);
    expect(
      await rows(
        "select event, points from public.gamification_points where organization_id = $1 and event = 'marketplace_listing_published'",
        [sellerOrg],
      ),
    ).toEqual([{ event: 'marketplace_listing_published', points: 5 }]);

    // Pausar exige anúncio publicado; falha volta ao estado anterior.
    const p = await begin(seller, 'tiktok', 'pause');
    expect(await finish(p.run_id, false, { error: 'TikTok Shop: erro 1' })).toBe(true);
    expect(
      await rows(
        "select publish_status, last_error from public.product_channel_configs where provider = 'tiktok'",
      ),
    ).toEqual([{ publish_status: 'review', last_error: 'TikTok Shop: erro 1' }]);
  });

  it('atributos: Shopee e TikTok Shop sem mapa de variações', async () => {
    await saveConfig('shopee');
    const save = (map: unknown) =>
      scalar(seller, "select public.save_listing_attributes($1, 'shopee', $2, $3)", [
        product,
        JSON.stringify([{ id: '100134', value_id: '501' }]),
        JSON.stringify(map),
      ]);
    await save({});
    expect(
      await rows("select attributes from public.product_channel_configs where provider = 'shopee'"),
    ).toEqual([{ attributes: [{ id: '100134', value_id: '501' }] }]);
    await expect(save({ Cor: 'COLOR' })).rejects.toThrow(/channels.invalid/);
  });

  it('consulta de categorias usa a loja conectada de quem pode', async () => {
    const lookup = (user: string) =>
      scalar(user, "select public.marketplace_lookup_connection($1, 'shopee')", [sellerOrg]);
    await expect(lookup(seller)).rejects.toThrow(/publish.not_connected/);
    const conn = await connectMarketplace(db, seller, sellerOrg, 'shopee', '880011');
    expect(await lookup(seller)).toBe(conn);
    await expect(lookup(sellerMember)).rejects.toThrow(/org.forbidden/);
  });

  it('Mercado Livre continua com os erros ml.*', async () => {
    await scalar(
      seller,
      "select public.save_product_channel_config($1, 'mercadolivre', true, 'Camiseta', 5990, 'classico', null, 'MLB31447', false)",
      [product],
    );
    await expect(
      scalar(seller, "select public.ml_publish_begin($1, 'publish')", [product]),
    ).rejects.toThrow(/ml.not_connected/);
    await expect(
      scalar(seller, "select public.ml_publish_begin($1, 'pause')", [product]),
    ).rejects.toThrow(/ml.not_published/);
    await expect(
      scalar(seller, "select public.ml_publish_begin($1, 'x')", [product]),
    ).rejects.toThrow(/ml.invalid_action/);
  });
});
