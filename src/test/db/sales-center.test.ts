// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { approveCatalog, asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let admin: string;
let seller: string;
let sellerMember: string;
let supplier: string;
let supplierMember: string;
let otherSupplier: string;
let sellerOrg: string;
let supplierOrg: string;
let otherSupplierOrg: string;
let hot: string; // margem 50%, com vendas
let wide: string; // margem 75%, sem vendas
let foreign: string; // anúncio de outro fornecedor

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

async function rows<T>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, userId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

const customer = {
  customer_name: 'Maria Cliente',
  ship_postal_code: '01310100',
  ship_street: 'Av. Paulista',
  ship_number: '1000',
  ship_district: 'Bela Vista',
  ship_city: 'São Paulo',
  ship_state: 'SP',
};

async function offer(
  user: string,
  org: string,
  sku: string,
  wholesale: number,
  suggested: number | null,
) {
  const p = await scalar<string>(
    user,
    "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, $2, $2, 9000, 'active') returning id",
    [org, sku],
  );
  const item = await scalar<string>(
    user,
    'select id from public.inventory_items where product_id = $1',
    [p],
  );
  await scalar(user, "select public.adjust_stock($1, 20, 'purchase', null, gen_random_uuid())", [
    item,
  ]);
  return scalar<string>(
    user,
    `insert into public.catalog_listings (organization_id, product_id, wholesale_price_cents, suggested_price_cents, is_published)
     values ($1, $2, $3, $4, true) returning id`,
    [org, p, wholesale, suggested],
  );
}

/** Vendedor importa o anúncio e vende `qty` unidades (gera pedido de fornecimento). */
async function sell(listing: string, qty: number) {
  const product = await scalar<string>(
    seller,
    "select public.import_catalog_listing($1, $2, 'FX-')",
    [sellerOrg, listing],
  );
  await scalar(seller, "update public.products set status = 'active' where id = $1", [product]);
  const item = await scalar<string>(
    seller,
    'select id from public.inventory_items where product_id = $1',
    [product],
  );
  const order = await scalar<string>(seller, 'select public.create_order($1, $2, $3)', [
    sellerOrg,
    JSON.stringify({ ...customer, items: [{ inventory_item_id: item, quantity: qty }] }),
    crypto.randomUUID(),
  ]);
  await scalar(seller, 'select public.confirm_order($1)', [order]);
  return order;
}

const addMaterial = (user: string, listing: string, org: string, kind: string, extra = {}) =>
  scalar<string>(
    user,
    `insert into public.sales_materials (organization_id, listing_id, kind, title, body, storage_path)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      org,
      listing,
      kind,
      (extra as { title?: string }).title ?? 'Material',
      (extra as { body?: string | null }).body ?? null,
      (extra as { path?: string | null }).path ?? null,
    ],
  );

beforeEach(async () => {
  db = await createTestDatabase();
  admin = await signUpUser(db, 'equipe@example.com', { full_name: 'Equipe' });
  await db.query("update public.profiles set role = 'admin' where id = $1", [admin]);
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  sellerMember = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Forn',
    account_type: 'supplier',
  });
  supplierMember = await signUpUser(db, 'fmembro@example.com', {
    full_name: 'Forn Membro',
    account_type: 'supplier',
  });
  otherSupplier = await signUpUser(db, 'outro@example.com', {
    full_name: 'Outro',
    account_type: 'supplier',
  });
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  supplierOrg = await scalar(supplier, "select public.create_organization('Fábrica X')");
  otherSupplierOrg = await scalar(otherSupplier, "select public.create_organization('Fábrica Y')");
  for (const [owner, org, email, invitee] of [
    [seller, sellerOrg, 'membro@example.com', sellerMember],
    [supplier, supplierOrg, 'fmembro@example.com', supplierMember],
  ] as const) {
    const inv = await scalar<string>(owner, "select public.invite_member($1, $2, 'member')", [
      org,
      email,
    ]);
    await scalar(invitee, 'select public.accept_invitation($1)', [inv]);
  }

  hot = await offer(supplier, supplierOrg, 'QUENTE', 2000, 4000);
  wide = await offer(supplier, supplierOrg, 'LARGO', 1000, 4000);
  foreign = await offer(otherSupplier, otherSupplierOrg, 'ALHEIO', 3000, null);
  await approveCatalog(db);
});

afterEach(async () => {
  await db.close();
});

describe('materiais de venda', () => {
  it('fornecedor cadastra textos e arquivos; vendedor lê pela Central', async () => {
    await addMaterial(supplier, hot, supplierOrg, 'script', {
      title: 'Roteiro 30s',
      body: 'Olha só essa caneca...',
    });
    await addMaterial(supplier, hot, supplierOrg, 'hashtags', {
      title: 'Hashtags',
      body: '#caneca #presente',
    });
    await addMaterial(supplier, hot, supplierOrg, 'video', {
      title: 'Vídeo demonstração',
      path: `${hot}/${crypto.randomUUID()}/demo.mp4`,
    });

    const detail = await scalar<{
      materials: { kind: string; title: string; body: string | null }[];
    }>(seller, 'select public.sales_center_listing($1)', [hot]);
    expect(detail.materials.map((m) => m.kind)).toEqual(['script', 'hashtags', 'video']);
    expect(detail.materials[0]!.body).toBe('Olha só essa caneca...');

    // Vendedor não lê a tabela direto nem cria materiais.
    expect(await rows(seller, 'select * from public.sales_materials')).toEqual([]);
    await expect(
      addMaterial(seller, hot, supplierOrg, 'title', { body: 'Título' }),
    ).rejects.toThrow(/row-level security/);
  });

  it('só owner/admin do fornecedor dono escreve; formato validado', async () => {
    await expect(
      addMaterial(supplierMember, hot, supplierOrg, 'title', { body: 'x' }),
    ).rejects.toThrow(/row-level security/);
    await expect(
      addMaterial(otherSupplier, hot, supplierOrg, 'title', { body: 'x' }),
    ).rejects.toThrow(/row-level security/);
    // Organização trocada: FK composta recusa.
    await expect(
      addMaterial(otherSupplier, foreign, supplierOrg, 'title', { body: 'x' }),
    ).rejects.toThrow();
    // Texto sem corpo; arquivo fora da pasta do anúncio.
    await expect(addMaterial(supplier, hot, supplierOrg, 'title')).rejects.toThrow(/check/);
    await expect(
      addMaterial(supplier, hot, supplierOrg, 'image', {
        path: `${wide}/${crypto.randomUUID()}/a.png`,
      }),
    ).rejects.toThrow(/check/);

    const id = await addMaterial(supplier, hot, supplierOrg, 'argument', { body: 'Barato' });
    // Membro do fornecedor lê; não edita.
    expect(await rows(supplierMember, 'select id from public.sales_materials')).toHaveLength(1);
    await scalar(supplierMember, "update public.sales_materials set body = 'hack' where id = $1", [
      id,
    ]);
    await scalar(supplier, "update public.sales_materials set body = 'Custa pouco' where id = $1", [
      id,
    ]);
    const body = await db.query<{ body: string }>(
      'select body from public.sales_materials where id = $1',
      [id],
    );
    expect(body.rows[0]!.body).toBe('Custa pouco');
    // Equipe remove (moderação).
    await scalar(admin, 'delete from public.sales_materials where id = $1', [id]);
    expect(await rows(supplier, 'select id from public.sales_materials')).toEqual([]);
  });

  it('limite de 50 materiais por anúncio', async () => {
    await db.query(
      `insert into public.sales_materials (organization_id, listing_id, kind, title, body)
       select $1, $2, 'title', 'T' || g, 'x' from generate_series(1, 50) g`,
      [supplierOrg, hot],
    );
    await expect(addMaterial(supplier, hot, supplierOrg, 'title', { body: 'x' })).rejects.toThrow(
      /sales.too_many_materials/,
    );
  });

  it('arquivos: fornecedor envia na pasta do anúncio; vendedor lê só de anúncio visível', async () => {
    const path = `${hot}/${crypto.randomUUID()}/demo.mp4`;
    await scalar(
      supplier,
      "insert into storage.objects (bucket_id, name) values ('sales-materials', $1)",
      [path],
    );
    await expect(
      scalar(
        otherSupplier,
        "insert into storage.objects (bucket_id, name) values ('sales-materials', $1)",
        [`${hot}/${crypto.randomUUID()}/x.mp4`],
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      scalar(
        supplier,
        "insert into storage.objects (bucket_id, name) values ('sales-materials', 'nao-e-uuid/x.mp4')",
      ),
    ).rejects.toThrow(/row-level security/);

    const sees = async (user: string) =>
      (await rows(user, 'select name from storage.objects where name = $1', [path])).length;
    expect(await sees(seller)).toBe(1);
    expect(await sees(supplierMember)).toBe(1);
    expect(await sees(otherSupplier)).toBe(0);

    await db.query(
      "update public.catalog_listings set moderation_status = 'blocked' where id = $1",
      [hot],
    );
    expect(await sees(seller)).toBe(0);
    await expect(scalar(seller, 'select public.sales_center_listing($1)', [hot])).rejects.toThrow(
      /catalog.listing_not_found/,
    );
  });
});

describe('vitrine e favoritos', () => {
  type Row = { name: string; units_30d: number; margin_bps: number | null; is_favorite: boolean };
  const center = (sort: string, user = seller, query: string | null = null) =>
    rows<Row>(
      user,
      'select name, units_30d, margin_bps, is_favorite from public.sales_center($1, $2, 24, 0)',
      [sort, query],
    );

  it('em alta por unidades reais; maior margem; novidades', async () => {
    await sell(hot, 3);
    const cancelled = await sell(foreign, 5);
    await scalar(seller, 'select public.cancel_order($1)', [cancelled]);

    expect((await center('trending')).map((r) => [r.name, r.units_30d])).toEqual([
      ['QUENTE', 3],
      ['ALHEIO', 0],
      ['LARGO', 0],
    ]);
    expect((await center('margin')).map((r) => [r.name, r.margin_bps])).toEqual([
      ['LARGO', 7500],
      ['QUENTE', 5000],
      ['ALHEIO', null],
    ]);
    expect((await center('new')).map((r) => r.name)).toEqual(['ALHEIO', 'LARGO', 'QUENTE']);
    expect((await center('new', seller, 'larg')).map((r) => r.name)).toEqual(['LARGO']);

    // Vendas antigas saem do "em alta".
    await db.query("update public.supplier_orders set created_at = now() - interval '31 days'");
    expect((await center('trending'))[0]!.units_30d).toBe(0);

    await expect(center('bogus')).rejects.toThrow(/sales.invalid_sort/);
    await expect(center('new', supplier)).rejects.toThrow(/catalog.sellers_only/);
  });

  it('favoritos são de cada usuário e só de anúncio visível', async () => {
    await scalar(seller, 'insert into public.listing_favorites (listing_id) values ($1)', [wide]);
    expect((await center('favorites')).map((r) => r.name)).toEqual(['LARGO']);
    expect((await center('new')).find((r) => r.name === 'LARGO')!.is_favorite).toBe(true);
    expect(await center('favorites', sellerMember)).toEqual([]);

    // Não dá para favoritar em nome de outro, nem sendo fornecedor, nem anúncio oculto.
    await expect(
      scalar(seller, 'insert into public.listing_favorites (user_id, listing_id) values ($1, $2)', [
        sellerMember,
        hot,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      scalar(supplier, 'insert into public.listing_favorites (listing_id) values ($1)', [hot]),
    ).rejects.toThrow(/row-level security/);
    await db.query('update public.catalog_listings set is_published = false where id = $1', [hot]);
    await expect(
      scalar(seller, 'insert into public.listing_favorites (listing_id) values ($1)', [hot]),
    ).rejects.toThrow(/row-level security/);

    // Anúncio que sai do ar some também dos favoritos.
    await db.query('update public.catalog_listings set is_published = false where id = $1', [wide]);
    expect(await center('favorites')).toEqual([]);

    await scalar(seller, 'delete from public.listing_favorites where listing_id = $1', [wide]);
    expect(await rows(seller, 'select * from public.listing_favorites')).toEqual([]);
  });
});

describe('campanhas para lives', () => {
  const save = (id: string | null, data: Record<string, unknown>, user = admin) =>
    scalar<string>(user, 'select public.admin_save_live_campaign($1, $2)', [
      id,
      JSON.stringify(data),
    ]);

  const now = Date.now();
  const iso = (hours: number) => new Date(now + hours * 3600_000).toISOString();
  const base = {
    name: 'Live de Canecas',
    description: 'Sexta às 20h',
    provider: 'tiktok',
    starts_at: iso(-1),
    ends_at: iso(3),
    commission_bps: 2500,
    status: 'published',
  };

  const estimate = (provider = 'tiktok') =>
    scalar<{ seller_commission_bps: number; seller_commission_source: string }>(
      seller,
      "select public.estimate_sale_split($1, $2, $3, 'padrao', null, 5000, 1)",
      [sellerOrg, hot, provider],
    );

  it('equipe cria e publica; vendedor vê, entra e ganha a comissão da campanha', async () => {
    const id = await save(null, { ...base, listing_ids: [hot, wide] });

    const list = await rows<{ name: string; listings: number; joined: boolean }>(
      seller,
      'select name, listings, joined from public.live_campaigns_for_seller($1)',
      [sellerOrg],
    );
    expect(list).toEqual([{ name: 'Live de Canecas', listings: 2, joined: false }]);

    // Sem participar, vale a comissão padrão (15%).
    expect(await estimate()).toMatchObject({
      seller_commission_bps: 1500,
      seller_commission_source: 'default',
    });

    await expect(
      scalar(sellerMember, 'select public.set_live_campaign_participation($1, $2, true)', [
        sellerOrg,
        id,
      ]),
    ).rejects.toThrow(/org.forbidden/);
    await scalar(seller, 'select public.set_live_campaign_participation($1, $2, true)', [
      sellerOrg,
      id,
    ]);
    expect(await estimate()).toMatchObject({
      seller_commission_bps: 2500,
      seller_commission_source: 'live_campaign',
    });
    // Campanha do TikTok não muda a comissão em outro marketplace.
    await db.query(
      "insert into public.marketplace_fee_rules (provider, listing_type, label, percent_bps) values ('shopee', 'padrao', 'Padrão', 1000)",
    );
    expect(await estimate('shopee')).toMatchObject({ seller_commission_source: 'default' });

    const detail = await scalar<{ joined: boolean; listings: { name: string }[] }>(
      seller,
      'select public.live_campaign_for_seller($1, $2)',
      [sellerOrg, id],
    );
    expect(detail.joined).toBe(true);
    expect(detail.listings.map((l) => l.name)).toEqual(['LARGO', 'QUENTE']);

    const center = await scalar<{ campaigns: { name: string; commission_bps: number }[] }>(
      seller,
      'select public.sales_center_listing($1)',
      [hot],
    );
    expect(center.campaigns).toEqual([
      expect.objectContaining({ name: 'Live de Canecas', commission_bps: 2500 }),
    ]);

    // Sair devolve a comissão das regras.
    await scalar(seller, 'select public.set_live_campaign_participation($1, $2, false)', [
      sellerOrg,
      id,
    ]);
    expect(await estimate()).toMatchObject({ seller_commission_source: 'default' });
  });

  it('comissão só vale no período, publicada e para produto incluído', async () => {
    const id = await save(null, { ...base, starts_at: iso(1), listing_ids: [wide] });
    await scalar(seller, 'select public.set_live_campaign_participation($1, $2, true)', [
      sellerOrg,
      id,
    ]);
    // Produto fora da campanha e campanha ainda não começou.
    expect(await estimate()).toMatchObject({ seller_commission_source: 'default' });
    await save(id, { ...base, listing_ids: [hot] });
    expect(await estimate()).toMatchObject({ seller_commission_source: 'live_campaign' });
    await save(id, { ...base, status: 'cancelled', listing_ids: [hot] });
    expect(await estimate()).toMatchObject({ seller_commission_source: 'default' });
    // Rascunho/cancelada não aparece para o vendedor.
    expect(
      await rows(seller, 'select * from public.live_campaigns_for_seller($1)', [sellerOrg]),
    ).toEqual([]);
    await expect(
      scalar(seller, 'select public.set_live_campaign_participation($1, $2, true)', [
        sellerOrg,
        id,
      ]),
    ).rejects.toThrow(/campaign.not_found/);
  });

  it('campanha encerrada não aceita participação e some da lista', async () => {
    const id = await save(null, { ...base, listing_ids: [hot] });
    await db.query(
      "update public.live_campaigns set starts_at = now() - interval '2 days', ends_at = now() - interval '1 hour'",
    );
    await expect(
      scalar(seller, 'select public.set_live_campaign_participation($1, $2, true)', [
        sellerOrg,
        id,
      ]),
    ).rejects.toThrow(/campaign.ended/);
    await expect(
      scalar(seller, 'select public.live_campaign_for_seller($1, $2)', [sellerOrg, id]),
    ).rejects.toThrow(/campaign.not_found/);
  });

  it('validação, permissões e auditoria', async () => {
    await expect(save(null, { ...base, listing_ids: [hot] }, seller)).rejects.toThrow(
      /admin.forbidden/,
    );
    await expect(
      save(null, { ...base, ends_at: base.starts_at, listing_ids: [hot] }),
    ).rejects.toThrow(/campaign.invalid/);
    await expect(
      save(null, { ...base, commission_bps: 10001, listing_ids: [hot] }),
    ).rejects.toThrow(/campaign.invalid/);
    await expect(save(null, { ...base, listing_ids: ['x'] })).rejects.toThrow(/campaign.invalid/);
    await expect(save(null, { ...base, listing_ids: [crypto.randomUUID()] })).rejects.toThrow(
      /campaign.listing_not_found/,
    );
    await expect(save(null, { ...base, listing_ids: [] })).rejects.toThrow(/campaign.no_listings/);
    await expect(save(crypto.randomUUID(), { ...base, listing_ids: [hot] })).rejects.toThrow(
      /campaign.not_found/,
    );

    const id = await save(null, { ...base, status: 'draft', listing_ids: [] });
    await save(id, { ...base, listing_ids: [hot, wide] });
    await scalar(seller, 'select public.set_live_campaign_participation($1, $2, true)', [
      sellerOrg,
      id,
    ]);
    const detail = await scalar<{
      listings: unknown[];
      participants: { organization_name: string }[];
    }>(admin, 'select public.admin_live_campaign($1)', [id]);
    expect(detail.listings).toHaveLength(2);
    expect(detail.participants.map((p) => p.organization_name)).toEqual(['Loja V']);
    expect(
      await rows(admin, 'select name, listings, participants from public.admin_live_campaigns()'),
    ).toEqual([{ name: 'Live de Canecas', listings: 2, participants: 1 }]);

    const audit = await db.query<{ action: string }>(
      'select action from public.admin_audit_log order by created_at',
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'live_campaign.created',
      'live_campaign.updated',
    ]);

    // Tabelas de campanha não têm acesso direto.
    for (const t of ['live_campaigns', 'live_campaign_listings', 'live_campaign_participants']) {
      await expect(rows(seller, `select * from public.${t}`)).rejects.toThrow(/permission denied/);
    }
    await expect(rows(seller, 'select * from public.admin_live_campaigns()')).rejects.toThrow(
      /admin.forbidden/,
    );
  });
});
