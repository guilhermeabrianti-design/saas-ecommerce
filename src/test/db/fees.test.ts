// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let admin: string;
let seller: string;
let seller2: string;
let supplier: string;
let sellerOrg: string;
let seller2Org: string;
let supplierOrg: string;
let listing: string;
let parentCat: string;
let childCat: string;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

async function rows<T>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, userId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

interface Split {
  sale_cents: number;
  marketplace_fee_cents: number;
  supplier_cents: number;
  seller_commission_bps: number;
  seller_commission_source: string;
  seller_commission_cents: number;
  platform_cents: number;
  platform_margin_bps: number;
  fee_rule: { label: string; percent_bps: number };
  campaign_rule: { campaign: string } | null;
}

const estimate = (
  provider: string,
  type: string,
  price: number,
  qty = 1,
  campaign: string | null = null,
  user = seller,
  org = sellerOrg,
) =>
  scalar<Split>(user, 'select public.estimate_sale_split($1, $2, $3, $4, $5, $6, $7)', [
    org,
    listing,
    provider,
    type,
    campaign,
    price,
    qty,
  ]);

const ruleId = (provider: string, type: string) =>
  scalar<string>(
    admin,
    'select id from public.marketplace_fee_rules where provider = $1 and listing_type = $2 and campaign is null order by min_unit_price_cents limit 1',
    [provider, type],
  );

const saveRule = (id: string | null, rule: Record<string, unknown>, user = admin) =>
  scalar<string>(user, 'select public.admin_save_fee_rule($1, $2)', [id, JSON.stringify(rule)]);

const saveCommission = (scope: string, target: string | null, bps: number, user = admin) =>
  scalar<string>(user, 'select public.admin_save_commission_rule($1, $2, $3)', [
    scope,
    target,
    bps,
  ]);

beforeEach(async () => {
  db = await createTestDatabase();
  admin = await signUpUser(db, 'staff@example.com', { full_name: 'Equipe' });
  await db.query("update public.profiles set role = 'admin' where id = $1", [admin]);
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  seller2 = await signUpUser(db, 'vend2@example.com', { full_name: 'Vendedor 2' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Forn',
    account_type: 'supplier',
  });
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  seller2Org = await scalar(seller2, "select public.create_organization('Loja W')");
  supplierOrg = await scalar(supplier, "select public.create_organization('Fábrica X')");

  parentCat = await scalar(admin, "select public.admin_save_category(null, 'Eletrônicos', null)");
  childCat = await scalar(admin, "select public.admin_save_category(null, 'Relógios', $1)", [
    parentCat,
  ]);

  const product = await scalar<string>(
    supplier,
    "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, 'SW', 'Smartwatch X', 8990, 'active') returning id",
    [supplierOrg],
  );
  listing = await scalar<string>(
    supplier,
    `insert into public.catalog_listings (organization_id, product_id, wholesale_price_cents, suggested_price_cents, is_published, category_id)
     values ($1, $2, 4000, 10000, true, $3) returning id`,
    [supplierOrg, product, childCat],
  );
});

afterEach(async () => {
  await db.close();
});

describe('fees: divisão da venda', () => {
  it('reproduz o exemplo: R$100 − R$16 marketplace − R$40 fornecedor − 15% vendedor = R$29', async () => {
    const ml = await ruleId('mercadolivre', 'classico');
    await saveRule(ml, {
      provider: 'mercadolivre',
      listing_type: 'classico',
      label: 'Clássico',
      percent_bps: 1600,
    });
    const s = await estimate('mercadolivre', 'classico', 10000);
    expect(s).toMatchObject({
      sale_cents: 10000,
      marketplace_fee_cents: 1600,
      supplier_cents: 4000,
      seller_commission_bps: 1500,
      seller_commission_source: 'default',
      seller_commission_cents: 1500,
      platform_cents: 2900,
      platform_margin_bps: 2900,
    });
  });

  it('TikTok Shop: faixa abaixo de R$50 (10% + R$4) e a partir de R$50 (6% + R$6), por item', async () => {
    expect((await estimate('tiktok', 'padrao', 4990)).marketplace_fee_cents).toBe(499 + 400);
    expect((await estimate('tiktok', 'padrao', 5000)).marketplace_fee_cents).toBe(300 + 600);
    const two = await estimate('tiktok', 'padrao', 4990, 2);
    expect(two.sale_cents).toBe(9980);
    expect(two.marketplace_fee_cents).toBe(998 + 800);
    expect(two.supplier_cents).toBe(8000);
  });

  it('Shopee: live 3%, campanha soma à base, tipo sem regra é "não configurado"', async () => {
    expect((await estimate('shopee', 'live', 10000)).marketplace_fee_cents).toBe(300);
    await saveRule(null, {
      provider: 'shopee',
      listing_type: 'live',
      label: 'Comissão extra',
      campaign: 'extra',
      percent_bps: 200,
    });
    const withExtra = await estimate('shopee', 'live', 10000, 1, 'extra');
    expect(withExtra.marketplace_fee_cents).toBe(500);
    expect(withExtra.campaign_rule?.campaign).toBe('extra');
    await expect(estimate('shopee', 'live', 10000, 1, 'outra')).rejects.toThrow(
      /fees.campaign_not_configured/,
    );
    await expect(estimate('shopee', 'padrao', 10000)).rejects.toThrow(/fees.not_configured/);
  });

  it('regra da categoria vence a geral e a da categoria-mãe vale para a subcategoria', async () => {
    const base = { provider: 'mercadolivre', listing_type: 'classico', label: 'Clássico' };
    await saveRule(null, { ...base, category_id: parentCat, percent_bps: 1200 });
    expect((await estimate('mercadolivre', 'classico', 10000)).marketplace_fee_cents).toBe(1200);
    await saveRule(null, { ...base, category_id: childCat, percent_bps: 1100 });
    expect((await estimate('mercadolivre', 'classico', 10000)).marketplace_fee_cents).toBe(1100);
  });

  it('faixas de preço com custo fixo', async () => {
    const ml = await ruleId('mercadolivre', 'premium');
    const base = { provider: 'mercadolivre', listing_type: 'premium', label: 'Premium' };
    await saveRule(ml, { ...base, min_unit_price_cents: 7900, percent_bps: 1900 });
    await saveRule(null, {
      ...base,
      min_unit_price_cents: 0,
      max_unit_price_cents: 7900,
      percent_bps: 1900,
      fixed_cents_per_item: 650,
    });
    expect((await estimate('mercadolivre', 'premium', 5000)).marketplace_fee_cents).toBe(950 + 650);
    expect((await estimate('mercadolivre', 'premium', 7900)).marketplace_fee_cents).toBe(1501);
  });

  it('receita negativa aparece como negativa (não é escondida)', async () => {
    const s = await estimate('mercadolivre', 'classico', 4500);
    expect(s.platform_cents).toBeLessThan(0);
  });

  it('valida entrada', async () => {
    await expect(estimate('tiktok', 'padrao', 0)).rejects.toThrow(/fees.invalid/);
    await expect(estimate('tiktok', 'padrao', 1000, 0)).rejects.toThrow(/fees.invalid/);
    await expect(estimate('tiktok', ' ', 1000)).rejects.toThrow(/fees.invalid/);
  });
});

describe('fees: comissão do vendedor', () => {
  it('precedência produto > vendedor > subcategoria > categoria-mãe > padrão', async () => {
    const src = async () => {
      const s = await estimate('tiktok', 'padrao', 10000);
      return [s.seller_commission_bps, s.seller_commission_source];
    };
    expect(await src()).toEqual([1500, 'default']);
    await saveCommission('category', parentCat, 1200);
    expect(await src()).toEqual([1200, 'parent_category']);
    await saveCommission('category', childCat, 1100);
    expect(await src()).toEqual([1100, 'category']);
    await saveCommission('seller', sellerOrg, 2000);
    expect(await src()).toEqual([2000, 'seller']);
    const product = await saveCommission('product', listing, 2500);
    expect(await src()).toEqual([2500, 'product']);

    // Outro vendedor não herda o acordo por vendedor.
    const other = await estimate('tiktok', 'padrao', 10000, 1, null, seller2, seller2Org);
    expect(other.seller_commission_bps).toBe(2500);
    await scalar(admin, 'select public.admin_delete_commission_rule($1)', [product]);
    expect(await src()).toEqual([2000, 'seller']);
    expect(
      (await estimate('tiktok', 'padrao', 10000, 1, null, seller2, seller2Org))
        .seller_commission_bps,
    ).toBe(1100);
  });

  it('comissão padrão é alterável (ex.: 20%) e não pode ser removida', async () => {
    const id = await saveCommission('default', null, 2000);
    expect((await estimate('tiktok', 'padrao', 10000)).seller_commission_cents).toBe(2000);
    expect(await saveCommission('default', null, 1000)).toBe(id);
    await expect(
      scalar(admin, 'select public.admin_delete_commission_rule($1)', [id]),
    ).rejects.toThrow(/fees.default_required/);
  });

  it('valida alvo: vendedor precisa ser organização vendedora', async () => {
    await expect(saveCommission('seller', supplierOrg, 1000)).rejects.toThrow(/fees.not_found/);
    await expect(saveCommission('default', sellerOrg, 1000)).rejects.toThrow(/fees.invalid/);
    await expect(saveCommission('category', null, 1000)).rejects.toThrow(/fees.invalid/);
    await expect(saveCommission('default', null, 10001)).rejects.toThrow(/fees.invalid/);
  });
});

describe('fees: acesso', () => {
  it('só a equipe altera regras e simula sem anúncio', async () => {
    for (const user of [seller, supplier]) {
      await expect(saveCommission('default', null, 1000, user)).rejects.toThrow(/admin.forbidden/);
      await expect(
        saveRule(null, { provider: 'tiktok', listing_type: 'x', label: 'X', percent_bps: 1 }, user),
      ).rejects.toThrow(/admin.forbidden/);
      await expect(
        scalar(user, "select public.admin_save_category(null, 'Casa', null)"),
      ).rejects.toThrow(/admin.forbidden/);
      await expect(
        scalar(user, 'select * from public.admin_list_commission_rules()'),
      ).rejects.toThrow(/admin.forbidden/);
      await expect(
        scalar(
          user,
          "select public.admin_simulate_split('tiktok', 'padrao', null, null, 1000, 1, 0, null)",
        ),
      ).rejects.toThrow(/admin.forbidden/);
    }
    const sim = await scalar<Split>(
      admin,
      "select public.admin_simulate_split('tiktok', 'padrao', null, null, 10000, 1, 4000, null)",
    );
    expect(sim.platform_cents).toBe(10000 - (600 + 600) - 4000 - 1500);
  });

  it('comissões são privadas; taxas e categorias são legíveis; escrita direta bloqueada', async () => {
    await expect(rows(seller, 'select * from public.commission_rules')).rejects.toThrow(
      /permission denied/,
    );
    expect((await rows(seller, 'select id from public.marketplace_fee_rules')).length).toBe(5);
    expect((await rows(supplier, 'select id from public.categories')).length).toBe(2);
    await expect(
      rows(seller, 'update public.marketplace_fee_rules set percent_bps = 0'),
    ).rejects.toThrow(/permission denied/);
    await expect(rows(seller, "insert into public.categories (name) values ('X')")).rejects.toThrow(
      /permission denied/,
    );
  });

  it('estimativa: só membros da organização vendedora informada', async () => {
    await expect(
      estimate('tiktok', 'padrao', 1000, 1, null, supplier, supplierOrg),
    ).rejects.toThrow(/fees.forbidden/);
    await expect(estimate('tiktok', 'padrao', 1000, 1, null, seller2, sellerOrg)).rejects.toThrow(
      /fees.forbidden/,
    );
    await expect(
      scalar(null, 'select public.estimate_sale_split($1, $2, $3, $4, $5, $6, $7)', [
        sellerOrg,
        listing,
        'tiktok',
        'padrao',
        null,
        1000,
        1,
      ]),
    ).rejects.toThrow(/permission denied/);
    await scalar(
      supplier,
      'update public.catalog_listings set is_published = false where id = $1',
      [listing],
    );
    await expect(estimate('tiktok', 'padrao', 1000)).rejects.toThrow(/catalog.listing_not_found/);
  });
});

describe('fees: regras e auditoria', () => {
  it('recusa faixas sobrepostas ativas; inativa pode, reativar não', async () => {
    const dup = {
      provider: 'mercadolivre',
      listing_type: 'classico',
      label: 'Dup',
      percent_bps: 1000,
    };
    await expect(saveRule(null, dup)).rejects.toThrow(/fees.overlap/);
    const inactive = await saveRule(null, { ...dup, is_active: false });
    await expect(
      scalar(admin, 'select public.admin_set_fee_rule_active($1, true)', [inactive]),
    ).rejects.toThrow(/fees.overlap/);
    // Faixas adjacentes [0, 50) e [50, ∞) do TikTok não se sobrepõem.
    const tiktok = await ruleId('tiktok', 'padrao');
    await saveRule(tiktok, {
      provider: 'tiktok',
      listing_type: 'padrao',
      label: 'Padrão',
      max_unit_price_cents: 5000,
      percent_bps: 900,
      fixed_cents_per_item: 400,
    });
    expect((await estimate('tiktok', 'padrao', 1000)).marketplace_fee_cents).toBe(90 + 400);
  });

  it('valida a regra (percentual, faixa, tipo)', async () => {
    const base = { provider: 'tiktok', listing_type: 'novo', label: 'Novo' };
    await expect(saveRule(null, { ...base, percent_bps: 10001 })).rejects.toThrow(/fees.invalid/);
    await expect(saveRule(null, { ...base, percent_bps: -1 })).rejects.toThrow(/fees.invalid/);
    await expect(
      saveRule(null, {
        ...base,
        percent_bps: 100,
        min_unit_price_cents: 500,
        max_unit_price_cents: 500,
      }),
    ).rejects.toThrow(/fees.invalid/);
    await expect(saveRule(null, { ...base, provider: 'nada', percent_bps: 100 })).rejects.toThrow(
      /fees.invalid/,
    );
    await expect(
      saveRule(null, { ...base, listing_type: 'Com Espaço', percent_bps: 100 }),
    ).rejects.toThrow(/fees.invalid/);
  });

  it('desativar tira a regra do cálculo', async () => {
    const live = await ruleId('shopee', 'live');
    await scalar(admin, 'select public.admin_set_fee_rule_active($1, false)', [live]);
    await expect(estimate('shopee', 'live', 1000)).rejects.toThrow(/fees.not_configured/);
    await expect(
      scalar(admin, 'select public.admin_set_fee_rule_active($1, false)', [live]),
    ).rejects.toThrow(/fees.no_change/);
  });

  it('toda alteração vai para a auditoria com resumo', async () => {
    await saveCommission('default', null, 2000);
    const live = await ruleId('shopee', 'live');
    await scalar(admin, 'select public.admin_set_fee_rule_active($1, false)', [live]);
    const entries = await rows<{ action: string; reason: string }>(
      admin,
      'select action, reason from public.admin_audit_entries(10, 0)',
    );
    expect(entries[0]).toMatchObject({ action: 'fees.rule_deactivated' });
    expect(entries[0]?.reason).toContain('3.00%');
    expect(entries[1]).toMatchObject({
      action: 'commission.saved',
      reason: 'Comissão padrão: 15.00% → 20.00%',
    });
  });
});

describe('fees: categorias', () => {
  it('dois níveis, nomes únicos por nível e inativa não é atribuída', async () => {
    await expect(
      scalar(admin, "select public.admin_save_category(null, 'Smart', $1)", [childCat]),
    ).rejects.toThrow(/fees.invalid_parent/);
    await expect(
      scalar(admin, "select public.admin_save_category(null, 'eletrônicos', null)"),
    ).rejects.toThrow(/fees.duplicate/);
    await expect(
      scalar(admin, "select public.admin_save_category($1, 'Eletrônicos', $2)", [
        parentCat,
        childCat,
      ]),
    ).rejects.toThrow(/fees.invalid_parent/);

    const casa = await scalar<string>(
      admin,
      "select public.admin_save_category(null, 'Casa', null)",
    );
    await scalar(admin, 'select public.admin_set_category_active($1, false)', [casa]);
    await expect(
      scalar(supplier, 'update public.catalog_listings set category_id = $1 where id = $2', [
        casa,
        listing,
      ]),
    ).rejects.toThrow(/fees.category_inactive/);
    // Anúncio que já está numa categoria desativada continua salvando outros campos.
    await scalar(admin, 'select public.admin_set_category_active($1, false)', [childCat]);
    await scalar(
      supplier,
      'update public.catalog_listings set wholesale_price_cents = 4100 where id = $1',
      [listing],
    );
  });

  it('o detalhe do catálogo mostra a categoria', async () => {
    const d = await scalar<{ category_name: string }>(
      seller,
      'select public.get_catalog_listing($1)',
      [listing],
    );
    expect(d.category_name).toBe('Eletrônicos › Relógios');
  });
});
