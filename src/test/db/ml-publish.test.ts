// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import {
  approveCatalog,
  asUser,
  connectMercadoLivre,
  createTestDatabase,
  signUpUser,
} from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerMember: string;
let supplier: string;
let sellerOrg: string;
let supplierOrg: string;
let product: string;

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

const saveConfig = (p: string, mcat: string | null = 'MLB31447', enabled = true) =>
  scalar<string>(
    seller,
    "select public.save_product_channel_config($1, 'mercadolivre', $2, 'Camiseta Azul', 8990, 'classico', null, $3, true)",
    [p, enabled, mcat],
  );

const saveAttrs = (user: string, p: string, attrs: unknown, map: unknown = {}) =>
  scalar(user, 'select public.save_ml_listing_attributes($1, $2, $3)', [
    p,
    JSON.stringify(attrs),
    JSON.stringify(map),
  ]);

type Begun = {
  run_id: string;
  action: string;
  connection_id: string;
  external_id: string | null;
  config: Record<string, unknown>;
  product: Record<string, unknown>;
  variants: { inventory_item_id: string; sku: string; available: number }[];
  images: string[];
};

const begin = (user: string, p: string, action = 'publish') =>
  scalar<Begun>(user, 'select public.ml_publish_begin($1, $2)', [p, action]);

const finish = (
  run: string,
  ok: boolean,
  over: Partial<{ id: string; url: string; status: string; error: string; links: unknown }> = {},
) =>
  service<boolean>('select public.ml_publish_finish($1, $2, $3, $4, $5, $6, $7)', [
    run,
    ok,
    over.id ?? null,
    over.url ?? null,
    over.status ?? (ok ? 'active' : null),
    over.error ?? null,
    JSON.stringify(over.links ?? []),
  ]);

const config = async () =>
  (
    await rows(
      "select publish_status, external_id, external_url, last_error, publish_run, connection_id from public.product_channel_configs where product_id = $1 and provider = 'mercadolivre'",
      [product],
    )
  )[0] as Record<string, unknown>;

const stock = (item: string, qty: number, user = seller) =>
  scalar(user, "select public.adjust_stock($1, $2, 'purchase', null, gen_random_uuid())", [
    item,
    qty,
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
    "select public.invite_member($1, 'membro@example.com', 'admin')",
    [sellerOrg],
  );
  await scalar(sellerMember, 'select public.accept_invitation($1)', [inv]);
  // Membro comum para os testes de permissão.
  await db.query("update public.organization_members set role = 'member' where user_id = $1", [
    sellerMember,
  ]);
  product = await scalar<string>(
    seller,
    "insert into public.products (organization_id, sku, name, description, brand, price_cents, status) values ($1, 'CAM', 'Camiseta', 'Algodão', 'Marca X', 8990, 'active') returning id",
    [sellerOrg],
  );
  await db.query(
    "insert into public.product_images (organization_id, product_id, storage_path) values ($1::uuid, $2::uuid, $1::text || '/' || $2::text || '/foto.jpg')",
    [sellerOrg, product],
  );
});

afterEach(async () => {
  await db.close();
});

describe('atributos do anúncio', () => {
  it('salva atributos e mapa de variações depois de salvar o canal', async () => {
    await expect(saveAttrs(seller, product, [])).rejects.toThrow(/channels.save_first/);
    await saveConfig(product);
    await saveAttrs(
      seller,
      product,
      [
        { id: 'BRAND', value_name: '  Marca X ' },
        { id: 'COLOR', value_id: '52049', value_name: 'Azul' },
      ],
      { Cor: 'COLOR' },
    );
    expect(
      await rows(
        "select attributes, variation_map from public.product_channel_configs where provider = 'mercadolivre'",
      ),
    ).toEqual([
      {
        attributes: [
          { id: 'BRAND', value_name: 'Marca X' },
          { id: 'COLOR', value_id: '52049', value_name: 'Azul' },
        ],
        variation_map: { Cor: 'COLOR' },
      },
    ]);
  });

  it('recusa formato errado, SKU manual, repetidos e quem não é owner/admin', async () => {
    await saveConfig(product);
    for (const bad of [
      { id: 'SELLER_SKU', value_name: 'X' },
      { id: 'brand', value_name: 'X' },
      { id: 'BRAND' },
      { id: 'BRAND', value_name: '' },
      { id: 'BRAND', value_name: 'X', extra: 1 },
    ]) {
      await expect(saveAttrs(seller, product, [bad])).rejects.toThrow(/channels.invalid/);
    }
    await expect(
      saveAttrs(seller, product, [
        { id: 'BRAND', value_name: 'A' },
        { id: 'BRAND', value_name: 'B' },
      ]),
    ).rejects.toThrow(/channels.invalid/);
    await expect(saveAttrs(seller, product, [], { Cor: 'color' })).rejects.toThrow(
      /channels.invalid/,
    );
    await expect(saveAttrs(seller, product, {})).rejects.toThrow(/channels.invalid/);
    await expect(saveAttrs(sellerMember, product, [])).rejects.toThrow(/products.not_found/);
  });
});

describe('publicação', () => {
  it('confere canal, categoria e conexão antes de começar', async () => {
    await expect(begin(seller, product)).rejects.toThrow(/channels.save_first/);
    await saveConfig(product, null);
    await expect(begin(seller, product)).rejects.toThrow(/ml.category_required/);
    await saveConfig(product, 'MLB31447', false);
    await expect(begin(seller, product)).rejects.toThrow(/channels.disabled/);
    await saveConfig(product);
    await expect(begin(seller, product)).rejects.toThrow(/ml.not_connected/);
    await connectMercadoLivre(db, seller, sellerOrg);
    await expect(begin(seller, product, 'pause')).rejects.toThrow(/ml.not_published/);
    await expect(begin(seller, product, 'apagar')).rejects.toThrow(/ml.invalid_action/);
    await expect(begin(sellerMember, product)).rejects.toThrow(/products.not_found/);
  });

  it('devolve os dados do anúncio, trava a execução e grava o resultado com os vínculos', async () => {
    await saveConfig(product);
    const conn = await connectMercadoLivre(db, seller, sellerOrg);
    const item = await scalar<string>(
      seller,
      'select id from public.inventory_items where product_id = $1',
      [product],
    );
    await stock(item, 5);

    const b = await begin(seller, product);
    expect(b).toMatchObject({
      action: 'publish',
      connection_id: conn,
      external_id: null,
      config: {
        title: 'Camiseta Azul',
        price_cents: 8990,
        listing_type: 'classico',
        category: 'MLB31447',
      },
      product: { sku: 'CAM', brand: 'Marca X', inventory_item_id: item, available: 5 },
      variants: [],
      images: [`${sellerOrg}/${product}/foto.jpg`],
    });
    expect((await config()).publish_status).toBe('publishing');
    await expect(begin(seller, product)).rejects.toThrow(/ml.busy/);

    // Só a Edge Function (service role) conclui.
    await expect(
      scalar(
        seller,
        "select public.ml_publish_finish($1, true, 'MLB1', null, 'active', null, '[]')",
        [b.run_id],
      ),
    ).rejects.toThrow(/permission denied/);

    expect(
      await finish(b.run_id, true, {
        id: 'MLB123',
        url: 'https://produto.mercadolivre.com.br/MLB-123',
        links: [
          { inventory_item_id: item, sku: 'CAM' },
          // Item de outro produto é ignorado.
          { inventory_item_id: '00000000-0000-4000-8000-000000000000', sku: 'X' },
        ],
      }),
    ).toBe(true);
    expect(await config()).toMatchObject({
      publish_status: 'active',
      external_id: 'MLB123',
      external_url: 'https://produto.mercadolivre.com.br/MLB-123',
      last_error: null,
      publish_run: null,
    });
    expect(
      await rows('select connection_id, inventory_item_id, external_id from public.listing_links'),
    ).toEqual([{ connection_id: conn, inventory_item_id: item, external_id: 'CAM' }]);
    // A mesma execução não conclui de novo.
    expect(await finish(b.run_id, true, { id: 'MLB999' })).toBe(false);

    // Pausar: falha volta ao estado anterior e guarda o erro.
    const p = await begin(seller, product, 'pause');
    expect(p.external_id).toBe('MLB123');
    await finish(p.run_id, false, { error: 'Mercado Livre: limite de requisições' });
    expect(await config()).toMatchObject({
      publish_status: 'active',
      last_error: 'Mercado Livre: limite de requisições',
    });
    const p2 = await begin(seller, product, 'pause');
    await finish(p2.run_id, true, { status: 'paused' });
    expect(await config()).toMatchObject({ publish_status: 'paused', external_id: 'MLB123' });

    // Republicar não duplica vínculos.
    const r = await begin(seller, product);
    await finish(r.run_id, true, {
      id: 'MLB123',
      links: [{ inventory_item_id: item, sku: 'CAM' }],
    });
    expect(await rows('select count(*)::int as n from public.listing_links')).toEqual([{ n: 1 }]);
  });

  it('primeira publicação com falha fica em erro; execução travada libera em 10 minutos', async () => {
    await saveConfig(product);
    await connectMercadoLivre(db, seller, sellerOrg);
    const b = await begin(seller, product);
    await finish(b.run_id, false, { error: 'Preencha os atributos obrigatórios: Marca.' });
    expect(await config()).toMatchObject({
      publish_status: 'error',
      external_id: null,
      last_error: 'Preencha os atributos obrigatórios: Marca.',
    });

    const stuck = await begin(seller, product);
    await db.query(
      "update public.product_channel_configs set publish_started_at = now() - interval '11 minutes'",
    );
    const again = await begin(seller, product);
    expect(again.run_id).not.toBe(stuck.run_id);
    // A execução antiga não conclui mais.
    expect(await finish(stuck.run_id, true, { id: 'MLB1' })).toBe(false);
  });

  it('anúncio publicado fica na conta em que foi criado', async () => {
    await saveConfig(product);
    const conn = await connectMercadoLivre(db, seller, sellerOrg);
    const b = await begin(seller, product);
    await finish(b.run_id, true, { id: 'MLB123' });
    await scalar(seller, "select public.set_connection_status($1, 'disconnected')", [conn]);
    await connectMercadoLivre(db, seller, sellerOrg, '888', 'Outra conta');
    await expect(begin(seller, product)).rejects.toThrow(/ml.connection_inactive/);
  });

  it('variações ativas com estoque; sem nenhuma ativa não publica', async () => {
    await saveConfig(product);
    await connectMercadoLivre(db, seller, sellerOrg);
    const vp = await scalar<string>(
      seller,
      `insert into public.product_variants (organization_id, product_id, sku, attributes)
       values ($1, $2, 'CAM-P', '{"Tamanho":"P"}') returning id`,
      [sellerOrg, product],
    );
    await scalar(
      seller,
      `insert into public.product_variants (organization_id, product_id, sku, attributes, is_active)
       values ($1, $2, 'CAM-M', '{"Tamanho":"M"}', false)`,
      [sellerOrg, product],
    );
    const vi = await scalar<string>(
      seller,
      'select id from public.inventory_items where variant_id = $1',
      [vp],
    );
    await stock(vi, 2);
    const b = await begin(seller, product);
    expect(b.variants).toEqual([
      {
        inventory_item_id: vi,
        sku: 'CAM-P',
        attributes: { Tamanho: 'P' },
        gtin: null,
        available: 2,
      },
    ]);
    expect(b.product).toMatchObject({ inventory_item_id: null, available: null });
    await finish(b.run_id, false, { error: 'x' });

    await db.query('update public.product_variants set is_active = false');
    await expect(begin(seller, product)).rejects.toThrow(/ml.no_active_variants/);
  });

  it('produto importado anuncia o estoque e as fotos do fornecedor', async () => {
    const sp = await scalar<string>(
      supplier,
      "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, 'BOL', 'Bolsa', 9000, 'active') returning id",
      [supplierOrg],
    );
    await db.query(
      "insert into public.product_images (organization_id, product_id, storage_path) values ($1::uuid, $2::uuid, $1::text || '/' || $2::text || '/capa.jpg')",
      [supplierOrg, sp],
    );
    const si = await scalar<string>(
      supplier,
      'select id from public.inventory_items where product_id = $1',
      [sp],
    );
    await stock(si, 9, supplier);
    const listing = await scalar<string>(
      supplier,
      `insert into public.catalog_listings (organization_id, product_id, wholesale_price_cents, is_published)
       values ($1, $2, 4000, true) returning id`,
      [supplierOrg, sp],
    );
    await approveCatalog(db);
    const imported = await scalar<string>(
      seller,
      "select public.import_catalog_listing($1, $2, 'FX-')",
      [sellerOrg, listing],
    );
    await saveConfig(imported);
    await connectMercadoLivre(db, seller, sellerOrg);
    const b = await begin(seller, imported);
    expect(b.product).toMatchObject({ sku: 'FX-BOL', available: 9 });
    expect(b.images).toEqual([`${supplierOrg}/${sp}/capa.jpg`]);
  });
});

describe('consultas de categoria', () => {
  it('só vendedores', async () => {
    await expect(scalar(seller, 'select public.ml_lookup_allowed()')).resolves.toBeDefined();
    await expect(scalar(supplier, 'select public.ml_lookup_allowed()')).rejects.toThrow(
      /channels.sellers_only/,
    );
    await expect(scalar(null, 'select public.ml_lookup_allowed()')).rejects.toThrow(
      /permission denied/,
    );
  });
});
