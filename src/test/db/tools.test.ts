// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerMember: string;
let outsider: string;
let sellerOrg: string;
let product: string;
let outsiderProduct: string;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

type Pricing = {
  price_cents: number;
  marketplace_fee_cents: number;
  fee_rule: { label: string; percent_bps: number; fixed_cents_per_item: number };
  tax_cents: number;
  anticipation_cents: number;
  profit_cents: number;
  margin_bps: number;
  target_margin_bps?: number;
};

interface Costs {
  provider?: string;
  type?: string;
  category?: string | null;
  cost?: number;
  shipping?: number;
  tax?: number;
  anticipation?: number;
}

const simulate = (price: number, c: Costs = {}, user: string | null = seller) =>
  scalar<Pricing>(user, 'select public.pricing_simulate($1, $2, $3, $4, $5, $6, $7, $8)', [
    c.provider ?? 'tiktok',
    c.type ?? 'padrao',
    c.category ?? null,
    price,
    c.cost ?? 2000,
    c.shipping ?? 0,
    c.tax ?? 0,
    c.anticipation ?? 0,
  ]);

const target = (margin: number, c: Costs = {}, user: string | null = seller) =>
  scalar<Pricing>(user, 'select public.pricing_target($1, $2, $3, $4, $5, $6, $7, $8)', [
    c.provider ?? 'tiktok',
    c.type ?? 'padrao',
    c.category ?? null,
    c.cost ?? 2000,
    c.shipping ?? 0,
    c.tax ?? 0,
    c.anticipation ?? 0,
    margin,
  ]);

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  sellerMember = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
  outsider = await signUpUser(db, 'out@example.com', { full_name: 'Outra Loja' });
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  const outsiderOrg = await scalar<string>(outsider, "select public.create_organization('Loja W')");
  const inv = await scalar<string>(
    seller,
    "select public.invite_member($1, 'membro@example.com', 'member')",
    [sellerOrg],
  );
  await scalar(sellerMember, 'select public.accept_invitation($1)', [inv]);
  product = await scalar<string>(
    seller,
    `insert into public.products (organization_id, sku, name, brand, description, price_cents, status)
     values ($1, 'CAN', 'Caneca Térmica', 'Marca X', 'Inox', 5990, 'active') returning id`,
    [sellerOrg],
  );
  outsiderProduct = await scalar<string>(
    outsider,
    `insert into public.products (organization_id, sku, name, price_cents) values ($1, 'X', 'Secreto', 100) returning id`,
    [outsiderOrg],
  );
});

afterEach(async () => {
  await db.close();
});

// Regras iniciais (Fase 15): TikTok padrão < R$ 50: 10% + R$ 4; ≥ R$ 50: 6% + R$ 6.
describe('simulador de lucro', () => {
  it('desconta taxa da faixa, impostos, antecipação, custo e frete', async () => {
    expect(await simulate(4000, { tax: 600, anticipation: 250, shipping: 500 })).toMatchObject({
      price_cents: 4000,
      marketplace_fee_cents: 800, // 400 + 400
      tax_cents: 240,
      anticipation_cents: 100,
      profit_cents: 4000 - 800 - 240 - 100 - 2000 - 500,
      margin_bps: 900,
    });
    // Acima de R$ 50 vale a outra faixa.
    expect(await simulate(6000)).toMatchObject({
      marketplace_fee_cents: 960, // 360 + 600
      fee_rule: { percent_bps: 600, fixed_cents_per_item: 600 },
      profit_cents: 3040,
    });
    // Prejuízo aparece como negativo.
    expect((await simulate(2100)).profit_cents).toBeLessThan(0);
  });

  it('validação e canal sem taxa cadastrada', async () => {
    await expect(simulate(0)).rejects.toThrow(/pricing.invalid/);
    await expect(simulate(1000, { tax: 10001 })).rejects.toThrow(/pricing.invalid/);
    await expect(simulate(1000, { cost: -1 })).rejects.toThrow(/pricing.invalid/);
    await expect(simulate(1000, { provider: 'shopee' })).rejects.toThrow(/fees.not_configured/);
    await expect(simulate(1000, {}, null)).rejects.toThrow();
  });
});

describe('preço-alvo', () => {
  it('menor preço que atinge a margem, na faixa certa', async () => {
    const r = await target(2000); // custo 20,00, margem 20%
    expect(r.price_cents).toBe(3429);
    expect(r.margin_bps).toBeGreaterThanOrEqual(2000);
    expect(r.target_margin_bps).toBe(2000);
    // Um centavo a menos não chega à margem.
    const below = await simulate(3428);
    expect(below.profit_cents * 10000).toBeLessThan(2000 * 3428);
  });

  it('quando a faixa barata não comporta, usa a próxima faixa', async () => {
    // Na faixa < R$ 50 o preço sairia 62,86 (fora dela); na faixa ≥ R$ 50 fecha em 62,17.
    const r = await target(2000, { cost: 4000 });
    expect(r.price_cents).toBe(6217);
    expect(r.fee_rule).toMatchObject({ percent_bps: 600 });
    expect(r.margin_bps).toBeGreaterThanOrEqual(2000);
  });

  it('impostos, antecipação e frete entram na conta', async () => {
    const plain = await target(1500);
    const loaded = await target(1500, { tax: 600, anticipation: 300, shipping: 800 });
    expect(loaded.price_cents).toBeGreaterThan(plain.price_cents);
    expect(loaded.margin_bps).toBeGreaterThanOrEqual(1500);
    expect(loaded.tax_cents).toBe(Math.round(loaded.price_cents * 0.06));
  });

  it('margem impossível e canal sem taxa', async () => {
    await expect(target(9000, { tax: 600 })).rejects.toThrow(/pricing.unreachable/);
    await expect(target(2000, { provider: 'shopee' })).rejects.toThrow(/fees.not_configured/);
    await expect(target(9901)).rejects.toThrow(/pricing.invalid/);
  });

  it('respeita regra por categoria', async () => {
    const cat = (
      await db.query<{ id: string }>(
        "insert into public.categories (name) values ('Casa') returning id",
      )
    ).rows[0]!.id;
    await db.query(
      `insert into public.marketplace_fee_rules (provider, listing_type, label, category_id, percent_bps)
       values ('tiktok', 'padrao', 'Casa', $1, 500)`,
      [cat],
    );
    const r = await target(2000, { category: cat });
    expect(r.fee_rule).toMatchObject({ label: 'Casa', percent_bps: 500 });
    expect(r.price_cents).toBe(Math.ceil((2000 * 10000) / (10000 - 500 - 2000)));
  });
});

describe('geradores com IA', () => {
  const beginGen = (user: string, kind: string, brief: string | null = null, prod = product) =>
    scalar<{
      usage_id: string;
      remaining: number;
      kind: string;
      brief: string | null;
      product: { name: string; price_cents: number };
    }>(user, 'select public.ai_begin_generation($1, $2, $3, $4)', [sellerOrg, prod, kind, brief]);

  it('reserva com dados do produto do banco', async () => {
    const r = await beginGen(seller, 'live_script', '  foco em Dia das Mães ');
    expect(r).toMatchObject({
      kind: 'live_script',
      brief: 'foco em Dia das Mães',
      remaining: 49,
      product: { name: 'Caneca Térmica', price_cents: 5990 },
    });
    const row = await db.query<{ feature: string; status: string }>(
      'select feature, status from public.ai_usage where id = $1',
      [r.usage_id],
    );
    expect(row.rows[0]).toEqual({ feature: 'live_script', status: 'started' });
    await scalar(seller, 'select public.ai_finish($1, true, 10, 20)', [r.usage_id]);
  });

  it('cota diária compartilhada com a descrição', async () => {
    await db.query(
      `insert into public.ai_usage (organization_id, feature, status)
       select $1, 'title', 'done' from generate_series(1, 49)`,
      [sellerOrg],
    );
    await beginGen(seller, 'title');
    await expect(beginGen(seller, 'ad_copy')).rejects.toThrow(/ai.quota_exceeded/);
    await expect(
      scalar(seller, 'select public.ai_begin_description($1, $2)', [sellerOrg, product]),
    ).rejects.toThrow(/ai.quota_exceeded/);
  });

  it('acesso, tipo, orientação e produto validados', async () => {
    await expect(beginGen(sellerMember, 'title')).rejects.toThrow(/org.forbidden/);
    await expect(beginGen(outsider, 'title')).rejects.toThrow(/org.forbidden/);
    await expect(beginGen(seller, 'poema')).rejects.toThrow(/ai.invalid/);
    await expect(beginGen(seller, 'title', 'x'.repeat(301))).rejects.toThrow(/ai.invalid/);
    await expect(beginGen(seller, 'title', null, outsiderProduct)).rejects.toThrow(
      /ai.product_not_found/,
    );
    // A descrição continua funcionando depois da refatoração da cota.
    const d = await scalar<{ remaining: number; product: { name: string } }>(
      seller,
      'select public.ai_begin_description($1, $2)',
      [sellerOrg, product],
    );
    expect(d).toMatchObject({ remaining: 49, product: { name: 'Caneca Térmica' } });
  });
});
