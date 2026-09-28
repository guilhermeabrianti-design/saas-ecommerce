// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { approveCatalog, asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerMember: string;
let supplier: string;
let sellerOrg: string;
let supplierOrg: string;
let shopify: string;
let woo: string;
let imported: string;
let supplierItem: string;
let own: string;

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

const save = (
  opts: {
    listing?: string | null;
    connection?: string;
    product?: string;
    title?: string;
    price?: number | null;
  },
  user = seller,
) =>
  scalar<string>(user, 'select public.save_channel_listing($1, $2, $3, $4, $5, $6, $7)', [
    sellerOrg,
    opts.listing ?? null,
    opts.connection ?? shopify,
    opts.product ?? imported,
    opts.title ?? 'Camiseta Azul Premium',
    'Descrição do anúncio',
    opts.price === undefined ? null : opts.price,
  ]);

type Begin = {
  run_id: string;
  error?: string;
  provider: string;
  target_status: string;
  option_names: string[];
  variants: {
    inventory_item_id: string;
    sku: string;
    price_cents: number;
    available: number;
    options: Record<string, string>;
  }[];
  image_paths: string[];
};

const begin = (listing: string, action = 'publish') =>
  scalar<Begin>(seller, 'select public.channel_listing_begin($1, $2)', [listing, action]);

const finish = (
  listing: string,
  run: string,
  ok: boolean,
  links: unknown[] = [],
  error: string | null = null,
) =>
  service('select public.channel_listing_finish($1, $2, $3, $4, $5, $6, $7)', [
    listing,
    run,
    ok,
    ok ? '9876543210' : null,
    ok ? 'https://loja.myshopify.com/products/camiseta' : null,
    error,
    JSON.stringify(links),
  ]);

const listingRow = (id: string) =>
  db
    .query<{ status: string; external_id: string | null; last_error: string | null }>(
      'select status, external_id, last_error from public.channel_listings where id = $1',
      [id],
    )
    .then((r) => r.rows[0]!);

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

  shopify = await scalar(
    seller,
    "select public.create_connection($1, 'shopify', 'Minha Shopify', 'loja.myshopify.com', 'segredo-do-webhook-123')",
    [sellerOrg],
  );
  woo = await scalar(
    seller,
    "select public.create_connection($1, 'woocommerce', 'Meu Woo', 'https://loja.example.com', 'segredo-do-webhook-456')",
    [sellerOrg],
  );

  // Produto do fornecedor com duas cores, importado pelo vendedor.
  const sp = await scalar<string>(
    supplier,
    "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, 'CAM', 'Camiseta', 9000, 'active') returning id",
    [supplierOrg],
  );
  for (const [sku, cor] of [
    ['CAM-AZ', 'Azul'],
    ['CAM-VM', 'Vermelho'],
  ]) {
    await scalar(
      supplier,
      `insert into public.product_variants (organization_id, product_id, sku, attributes)
       values ($1, $2, $3, jsonb_build_object('Cor', $4::text))`,
      [supplierOrg, sp, sku, cor],
    );
  }
  supplierItem = await scalar<string>(
    supplier,
    "select i.id from public.inventory_items i join public.product_variants v on v.id = i.variant_id where v.sku = 'CAM-AZ'",
  );
  await scalar(
    supplier,
    "select public.adjust_stock($1, 40, 'purchase', null, gen_random_uuid())",
    [supplierItem],
  );
  const listing = await scalar<string>(
    supplier,
    `insert into public.catalog_listings (organization_id, product_id, wholesale_price_cents, suggested_price_cents, is_published)
     values ($1, $2, 2000, 5990, true) returning id`,
    [supplierOrg, sp],
  );
  await approveCatalog(db);
  imported = await scalar<string>(seller, "select public.import_catalog_listing($1, $2, 'FX-')", [
    sellerOrg,
    listing,
  ]);
  await scalar(
    seller,
    "update public.products set status = 'active', price_cents = 5990 where id = $1",
    [imported],
  );

  own = await scalar<string>(
    seller,
    "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, 'CANECA', 'Caneca', 3500, 'active') returning id",
    [sellerOrg],
  );
});

afterEach(async () => {
  await db.close();
});

describe('anúncios: cadastro', () => {
  it('cria, edita, duplica para outra conexão e apaga rascunho', async () => {
    const id = await save({ price: 6990 });
    await expect(save({})).rejects.toThrow(/listings.already_exists/);
    await save({ listing: id, title: 'Camiseta Azul', price: null });
    expect(
      (await db.query('select title, price_cents from public.channel_listings where id = $1', [id]))
        .rows[0],
    ).toEqual({ title: 'Camiseta Azul', price_cents: null });

    const copy = await scalar<string>(seller, 'select public.duplicate_channel_listing($1, $2)', [
      id,
      woo,
    ]);
    expect(await listingRow(copy)).toMatchObject({ status: 'draft', external_id: null });

    await scalar(seller, 'select public.delete_channel_listing($1)', [copy]);
    expect(await scalar(seller, 'select count(*)::int from public.channel_listings')).toBe(1);
  });

  it('só owner/admin do vendedor, conexão ativa e produto da própria loja', async () => {
    await expect(save({}, sellerMember)).rejects.toThrow(/listings.forbidden/);
    await expect(save({ title: 'x' })).rejects.toThrow(/listings.invalid/);
    const supplierProduct = await scalar<string>(
      supplier,
      'select id from public.products where organization_id = $1 limit 1',
      [supplierOrg],
    );
    await expect(save({ product: supplierProduct })).rejects.toThrow(/listings.invalid_product/);
    await scalar(seller, "select public.set_connection_status($1, 'paused')", [shopify]);
    await expect(save({})).rejects.toThrow(/listings.connection_inactive/);
    expect(await scalar(sellerMember, 'select count(*)::int from public.channel_listings')).toBe(0);
    await expect(
      scalar(seller, "update public.channel_listings set status = 'active'"),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('anúncios: publicação', () => {
  it('importado: variações com SKU, opções, preço e estoque do fornecedor; vincula SKUs', async () => {
    const id = await save({ price: 6990 });
    const run = await begin(id);
    expect(run.error).toBeUndefined();
    expect(run).toMatchObject({
      provider: 'shopify',
      target_status: 'active',
      option_names: ['Cor'],
    });
    expect(run.variants.map((v) => [v.sku, v.price_cents, v.available, v.options.Cor])).toEqual([
      ['FX-CAM-AZ', 6990, 40, 'Azul'],
      ['FX-CAM-VM', 6990, 0, 'Vermelho'],
    ]);
    expect((await listingRow(id)).status).toBe('publishing');
    await expect(begin(id)).rejects.toThrow(/listings.busy/);

    await service("select public.channel_listing_step($1, $2, 'product', 'ok', 'Produto criado')", [
      id,
      run.run_id,
    ]);
    await finish(
      id,
      run.run_id,
      true,
      run.variants.map((v) => ({ inventory_item_id: v.inventory_item_id, sku: v.sku })),
    );
    expect(await listingRow(id)).toMatchObject({ status: 'active', external_id: '9876543210' });
    expect(await scalar(seller, 'select count(*)::int from public.listing_links')).toBe(2);
    const steps = await asUser(
      db,
      seller,
      async (tx) =>
        (
          await tx.query<{ step: string; status: string }>(
            'select step, status from public.channel_listing_steps where listing_id = $1 order by id',
            [id],
          )
        ).rows,
    );
    expect(steps.map((s) => `${s.step}:${s.status}`)).toEqual([
      'validate:ok',
      'product:ok',
      'links:ok',
      'done:ok',
    ]);

    // Estoque do fornecedor mudou → fila de envio para o anúncio.
    await scalar(
      supplier,
      "select public.adjust_stock($1, -5, 'adjustment', null, gen_random_uuid())",
      [supplierItem],
    );
    expect(
      await db
        .query('select available from public.stock_sync_outbox where done_at is null')
        .then((r) => r.rows),
    ).toEqual([{ available: 35 }]);

    // Pausar e reativar; republicar um pausado mantém pausado.
    const pause = await begin(id, 'pause');
    await finish(id, pause.run_id, true);
    expect((await listingRow(id)).status).toBe('paused');
    const republish = await begin(id);
    expect(republish.target_status).toBe('paused');
    await finish(id, republish.run_id, true);
    expect((await listingRow(id)).status).toBe('paused');
    await expect(scalar(seller, 'select public.delete_channel_listing($1)', [id])).rejects.toThrow(
      /listings.already_published/,
    );
  });

  it('produto próprio sem variações; validação barra produto indisponível e registra a etapa', async () => {
    const id = await save({ product: own, connection: woo });
    const run = await begin(id);
    expect(run.variants).toEqual([
      expect.objectContaining({ sku: 'CANECA', price_cents: 3500, options: {} }),
    ]);
    await finish(id, run.run_id, false, [], 'WooCommerce: credenciais recusadas pelo marketplace');
    expect(await listingRow(id)).toMatchObject({
      status: 'error',
      last_error: 'WooCommerce: credenciais recusadas pelo marketplace',
    });
    expect(
      await scalar(
        seller,
        "select count(*)::int from public.integration_events where kind = 'listing.publish' and status = 'error'",
      ),
    ).toBe(1);

    await scalar(seller, "update public.products set status = 'archived' where id = $1", [own]);
    const blocked = await begin(id);
    expect(blocked.error).toBe('listings.product_inactive');
    expect((await listingRow(id)).status).toBe('error');
    await expect(begin(id, 'pause')).rejects.toThrow(/listings.not_published/);
  });

  it('execução antiga não conclui; etapas e conclusão só pelo service role', async () => {
    const id = await save({});
    const run = await begin(id);
    await expect(
      service("select public.channel_listing_step($1, gen_random_uuid(), 'product', 'ok', null)", [
        id,
      ]),
    ).rejects.toThrow(/listings.stale_run/);
    await expect(
      scalar(seller, 'select public.channel_listing_finish($1, $2, true, null, null, null, null)', [
        id,
        run.run_id,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      scalar(sellerMember, "select public.channel_listing_begin($1, 'publish')", [id]),
    ).rejects.toThrow(/listings.not_found/);
  });
});
