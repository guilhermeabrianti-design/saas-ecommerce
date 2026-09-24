// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { approveCatalog, asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerMember: string;
let supplier: string;
let outsider: string;
let sellerOrg: string;
let supplierOrg: string;
let listing: string;
let ownProduct: string;
let ownItem: string;

// CPF/CNPJ de teste com dígitos verificadores válidos.
const CPF = '52998224725';
const CNPJ = '11222333000181';

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

const createOrder = (quantity = 1) =>
  scalar<string>(seller, 'select public.create_order($1, $2, $3)', [
    sellerOrg,
    JSON.stringify({ ...customer, items: [{ inventory_item_id: ownItem, quantity }] }),
    crypto.randomUUID(),
  ]);

type Step = { key: string; done: boolean };
const onboarding = (userId: string) =>
  scalar<Step[]>(userId, 'select public.seller_onboarding($1)', [sellerOrg]);
const doneKeys = async (userId: string) =>
  (await onboarding(userId)).filter((s) => s.done).map((s) => s.key);

const dashboard = (userId: string, days = 30) =>
  scalar<Record<string, number>>(userId, 'select public.seller_dashboard($1, $2)', [
    sellerOrg,
    days,
  ]);

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  sellerMember = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Forn',
    account_type: 'supplier',
  });
  outsider = await signUpUser(db, 'out@example.com', { full_name: 'Outra Loja' });
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  supplierOrg = await scalar(supplier, "select public.create_organization('Fábrica X')");
  await scalar(outsider, "select public.create_organization('Loja W')");
  const inv = await scalar<string>(
    seller,
    "select public.invite_member($1, 'membro@example.com', 'member')",
    [sellerOrg],
  );
  await scalar(sellerMember, 'select public.accept_invitation($1)', [inv]);

  // Catálogo do fornecedor: duas ofertas com margens diferentes e uma sem estoque.
  const offer = async (sku: string, wholesale: number, suggested: number | null, stock: number) => {
    const p = await scalar<string>(
      supplier,
      "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, $2, $2, 9000, 'active') returning id",
      [supplierOrg, sku],
    );
    if (stock > 0) {
      const item = await scalar<string>(
        supplier,
        'select id from public.inventory_items where product_id = $1',
        [p],
      );
      await scalar(
        supplier,
        "select public.adjust_stock($1, $2, 'purchase', null, gen_random_uuid())",
        [item, stock],
      );
    }
    return scalar<string>(
      supplier,
      `insert into public.catalog_listings (organization_id, product_id, wholesale_price_cents, suggested_price_cents, is_published)
       values ($1, $2, $3, $4, true) returning id`,
      [supplierOrg, p, wholesale, suggested],
    );
  };
  listing = await offer('MARGEM-50', 2000, 4000, 5);
  await offer('MARGEM-75', 1000, 4000, 5);
  await offer('SEM-ESTOQUE', 1000, 9000, 0);
  await offer('SEM-SUGESTAO', 1000, null, 5);
  await approveCatalog(db);

  ownProduct = await scalar<string>(
    seller,
    "insert into public.products (organization_id, sku, name, price_cents, cost_cents) values ($1, 'PROPRIO', 'Caneca', 3000, 1000) returning id",
    [sellerOrg],
  );
  ownItem = await scalar(seller, 'select id from public.inventory_items where product_id = $1', [
    ownProduct,
  ]);
  await scalar(seller, "select public.adjust_stock($1, 20, 'purchase', null, gen_random_uuid())", [
    ownItem,
  ]);
});

afterEach(async () => {
  await db.close();
});

describe('perfil: telefone e CPF/CNPJ', () => {
  const profile = (id: string) =>
    db
      .query<{ phone: string | null; document: string | null }>(
        'select phone, document from public.profiles where id = $1',
        [id],
      )
      .then((r) => r.rows[0]!);

  it('o cadastro guarda telefone e documento válidos, só com dígitos', async () => {
    const id = await signUpUser(db, 'novo@example.com', {
      full_name: 'Novo',
      phone: '(11) 91234-5678',
      document: '529.982.247-25',
    });
    expect(await profile(id)).toEqual({ phone: '11912345678', document: CPF });

    const pj = await signUpUser(db, 'pj@example.com', { phone: '1133334444', document: CNPJ });
    expect(await profile(pj)).toEqual({ phone: '1133334444', document: CNPJ });
  });

  it('valor inválido no cadastro é descartado sem impedir a conta', async () => {
    const id = await signUpUser(db, 'ruim@example.com', {
      full_name: 'Ruim',
      phone: '0012345',
      document: '11111111111',
    });
    expect(await profile(id)).toEqual({ phone: null, document: null });
  });

  it('o usuário atualiza os próprios dados e o banco valida dígitos verificadores', async () => {
    await scalar(seller, 'update public.profiles set phone = $1, document = $2 where id = $3', [
      '21987654321',
      CNPJ,
      seller,
    ]);
    expect(await profile(seller)).toEqual({ phone: '21987654321', document: CNPJ });

    await expect(
      scalar(seller, "update public.profiles set document = '52998224724' where id = $1", [seller]),
    ).rejects.toThrow(/check/);
    await expect(
      scalar(seller, "update public.profiles set document = '11222333000182' where id = $1", [
        seller,
      ]),
    ).rejects.toThrow(/check/);
    // Celular precisa começar com 9; DDD sem zero.
    await expect(
      scalar(seller, "update public.profiles set phone = '11812345678' where id = $1", [seller]),
    ).rejects.toThrow(/check/);
    await expect(
      scalar(seller, "update public.profiles set phone = '0112345678' where id = $1", [seller]),
    ).rejects.toThrow(/check/);
  });

  it('ninguém altera o perfil de outra pessoa nem o próprio papel', async () => {
    await scalar(outsider, 'update public.profiles set phone = $1 where id = $2', [
      '11912345678',
      seller,
    ]);
    expect((await profile(seller)).phone).toBeNull();
    await expect(
      scalar(seller, "update public.profiles set role = 'admin' where id = $1", [seller]),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('checklist do vendedor', () => {
  it('cada passo é marcado pelos dados reais', async () => {
    expect((await onboarding(seller)).map((s) => s.key)).toEqual([
      'profile',
      'products',
      'active_product',
      'channel',
      'first_order',
    ]);
    // Produto próprio já cadastrado (rascunho).
    expect(await doneKeys(seller)).toEqual(['products']);

    await scalar(seller, 'update public.profiles set phone = $1, document = $2 where id = $3', [
      '11912345678',
      CPF,
      seller,
    ]);
    await scalar(seller, "update public.products set status = 'active' where id = $1", [
      ownProduct,
    ]);
    await scalar(
      seller,
      "select public.create_connection($1, 'shopify', 'Minha loja', 'loja.myshopify.com', $2)",
      [sellerOrg, 'segredo-muito-longo-123'],
    );
    const order = await createOrder();
    expect(await doneKeys(seller)).toEqual([
      'profile',
      'products',
      'active_product',
      'channel',
      'first_order',
    ]);

    // Perfil é de quem consulta: o membro ainda não completou o dele.
    expect(await doneKeys(sellerMember)).not.toContain('profile');

    // Pedido cancelado não conta como primeira venda.
    await scalar(seller, 'select public.cancel_order($1)', [order]);
    expect(await doneKeys(seller)).not.toContain('first_order');
  });

  it('passo da Academia só aparece com curso liberado e conclui com uma aula', async () => {
    // Conteúdo gravado direto (como a equipe faria).
    const course = (
      await db.query<{ id: string }>(
        "insert into public.academy_courses (title, status) values ('Começando', 'published') returning id",
      )
    ).rows[0]!.id;
    const mod = await db.query<{ id: string }>(
      "insert into public.academy_modules (course_id, title) values ($1, 'Módulo') returning id",
      [course],
    );
    const lesson = await db.query<{ id: string }>(
      `insert into public.academy_lessons (course_id, module_id, title, youtube_id, duration_seconds, unlock_rule, is_required)
       values ($1, $2, 'Aula 1', 'dQw4w9WgXcQ', 600, 'none', true) returning id`,
      [course, mod.rows[0]!.id],
    );
    const academy = async () => (await onboarding(seller)).find((s) => s.key === 'academy');
    expect(await academy()).toEqual({ key: 'academy', done: false });

    await scalar(seller, 'select public.academy_set_completed($1, true)', [lesson.rows[0]!.id]);
    expect(await academy()).toEqual({ key: 'academy', done: true });

    // Curso só para fornecedores não entra no checklist do vendedor.
    await db.query("update public.academy_courses set audience = 'supplier'");
    expect(await academy()).toBeUndefined();
  });

  it('só membros de organização vendedora consultam', async () => {
    await expect(
      scalar(outsider, 'select public.seller_onboarding($1)', [sellerOrg]),
    ).rejects.toThrow(/org.forbidden/);
    await expect(
      scalar(supplier, 'select public.seller_onboarding($1)', [supplierOrg]),
    ).rejects.toThrow(/org.forbidden/);
    await expect(
      scalar(null, 'select public.seller_onboarding($1)', [sellerOrg]),
    ).rejects.toThrow();
  });
});

describe('painel do vendedor', () => {
  it('vendi, lucro bruto, recebido, a receber e a pagar', async () => {
    await scalar(seller, "update public.products set status = 'active' where id = $1", [
      ownProduct,
    ]);
    const a = await createOrder(2); // 6.000, custo 2.000
    const b = await createOrder(1); // 3.000
    const c = await createOrder(1);
    await scalar(seller, 'select public.cancel_order($1)', [c]);
    await scalar(seller, "select public.record_order_payment($1, 6000, 'pix', null, $2)", [
      a,
      crypto.randomUUID(),
    ]);
    await scalar(seller, "select public.record_order_payment($1, 1000, 'pix', null, $2)", [
      b,
      crypto.randomUUID(),
    ]);
    await scalar(seller, "select public.refund_order_payment($1, 500, 'pix', 'troca', $2)", [
      b,
      crypto.randomUUID(),
    ]);

    expect(await dashboard(seller)).toMatchObject({
      days: 30,
      orders: 2,
      sold_cents: 9000,
      gross_profit_cents: 6000,
      units_without_cost: 0,
      received_cents: 6500,
      receivable_cents: 2500,
      receivable_orders: 1,
      payable_cents: 0,
      payable_orders: 0,
    });
  });

  it('a pagar: pedidos de fornecimento enviados e não pagos', async () => {
    const imported = await scalar<string>(
      seller,
      "select public.import_catalog_listing($1, $2, 'FX-')",
      [sellerOrg, listing],
    );
    await scalar(seller, "update public.products set status = 'active' where id = $1", [imported]);
    const item = await scalar<string>(
      seller,
      'select id from public.inventory_items where product_id = $1',
      [imported],
    );
    const order = await scalar<string>(seller, 'select public.create_order($1, $2, $3)', [
      sellerOrg,
      JSON.stringify({ ...customer, items: [{ inventory_item_id: item, quantity: 2 }] }),
      crypto.randomUUID(),
    ]);
    await scalar(seller, 'select public.confirm_order($1)', [order]);
    const so = await scalar<string>(
      supplier,
      'select id from public.supplier_orders where order_id = $1',
      [order],
    );
    expect(await dashboard(seller)).toMatchObject({ payable_cents: 0 });
    await scalar(supplier, "select public.ship_supplier_order($1, 'Correios', 'BR123456789')", [
      so,
    ]);
    expect(await dashboard(seller)).toMatchObject({ payable_cents: 4000, payable_orders: 1 });
    await scalar(seller, 'select public.pay_supplier_order($1)', [so]);
    expect(await dashboard(seller)).toMatchObject({ payable_cents: 0, payable_orders: 0 });
  });

  it('só owner/admin de vendedor; período validado', async () => {
    await expect(dashboard(sellerMember)).rejects.toThrow(/org.forbidden/);
    await expect(dashboard(outsider)).rejects.toThrow(/org.forbidden/);
    await expect(
      scalar(supplier, 'select public.seller_dashboard($1, 30)', [supplierOrg]),
    ).rejects.toThrow(/org.forbidden/);
    await expect(dashboard(seller, 0)).rejects.toThrow(/analytics.invalid_period/);
  });
});

describe('séries e canais', () => {
  beforeEach(async () => {
    await scalar(seller, "update public.products set status = 'active' where id = $1", [
      ownProduct,
    ]);
  });

  it('dia, semana e mês cobrem o período, com baldes vazios zerados', async () => {
    await createOrder(1);
    // Pedido de 40 dias atrás.
    const old = await createOrder(2);
    await db.query(
      "update public.orders set created_at = now() - interval '40 days' where id = $1",
      [old],
    );

    type Row = { period_start: string; orders: number; amount_cents: number };
    const series = (days: number, bucket: string) =>
      rows<Row>(
        seller,
        'select period_start::text, orders::int, amount_cents::int from public.analytics_series($1, $2, $3)',
        [sellerOrg, days, bucket],
      );

    const daily = await series(30, 'day');
    expect(daily).toHaveLength(30);
    expect(daily.reduce((s, r) => s + r.amount_cents, 0)).toBe(3000);

    const weekly = await series(90, 'week');
    expect(weekly.length).toBeGreaterThanOrEqual(13);
    expect(weekly.length).toBeLessThanOrEqual(14);
    for (const w of weekly) expect(new Date(`${w.period_start}T12:00:00Z`).getUTCDay()).toBe(1);
    expect(weekly.reduce((s, r) => s + r.orders, 0)).toBe(2);

    const monthly = await series(90, 'month');
    for (const m of monthly) expect(m.period_start.endsWith('-01')).toBe(true);
    expect(monthly.reduce((s, r) => s + r.amount_cents, 0)).toBe(9000);

    await expect(series(30, 'year')).rejects.toThrow(/analytics.invalid_bucket/);
    await expect(
      rows(sellerMember, 'select * from public.analytics_series($1, 30, $2)', [sellerOrg, 'day']),
    ).rejects.toThrow(/org.forbidden/);
  });

  it('fornecedor também tem série (fornecimentos)', async () => {
    const r = await rows<{ n: number }>(
      supplier,
      "select count(*)::int as n from public.analytics_series($1, 7, 'day')",
      [supplierOrg],
    );
    expect(r[0]!.n).toBe(7);
  });

  it('canais: manual e provedor da conexão que trouxe o pedido', async () => {
    await createOrder(1);
    const fromShop = await createOrder(2);
    const connection = await scalar<string>(
      seller,
      "select public.create_connection($1, 'shopify', 'Minha loja', 'loja.myshopify.com', $2)",
      [sellerOrg, 'segredo-muito-longo-123'],
    );
    await db.query(
      "insert into public.external_orders (organization_id, connection_id, external_id, order_id) values ($1, $2, '1001', $3)",
      [sellerOrg, connection, fromShop],
    );

    const channels = await rows<{ channel: string; orders: number; amount_cents: number }>(
      seller,
      'select channel, orders::int, amount_cents::int from public.analytics_channels($1, 30)',
      [sellerOrg],
    );
    expect(channels).toEqual([
      { channel: 'shopify', orders: 1, amount_cents: 6000 },
      { channel: 'manual', orders: 1, amount_cents: 3000 },
    ]);
    await expect(
      rows(supplier, 'select * from public.analytics_channels($1, 30)', [supplierOrg]),
    ).rejects.toThrow(/org.forbidden/);
  });
});

describe('o que vender', () => {
  type Suggestion = { name: string; margin_bps: number; available: number };
  const suggestions = (userId: string) =>
    rows<Suggestion>(
      userId,
      'select name, margin_bps, available from public.seller_suggestions($1, 10)',
      [sellerOrg],
    );

  it('anúncios visíveis com estoque e margem sugerida, da maior para a menor', async () => {
    expect(await suggestions(seller)).toEqual([
      { name: 'MARGEM-75', margin_bps: 7500, available: 5 },
      { name: 'MARGEM-50', margin_bps: 5000, available: 5 },
    ]);
    // Membro também vê (não há dado financeiro da loja aqui).
    expect(await suggestions(sellerMember)).toHaveLength(2);
  });

  it('some ao importar e respeita a moderação', async () => {
    await scalar(seller, "select public.import_catalog_listing($1, $2, 'FX-')", [
      sellerOrg,
      listing,
    ]);
    expect((await suggestions(seller)).map((s) => s.name)).toEqual(['MARGEM-75']);

    await db.query("update public.catalog_listings set moderation_status = 'blocked'");
    expect(await suggestions(seller)).toEqual([]);
  });

  it('fornecedor e estranhos não consultam', async () => {
    await expect(
      rows(outsider, 'select * from public.seller_suggestions($1, 5)', [sellerOrg]),
    ).rejects.toThrow(/org.forbidden/);
    await expect(
      rows(supplier, 'select * from public.seller_suggestions($1, 5)', [supplierOrg]),
    ).rejects.toThrow(/org.forbidden/);
  });
});
