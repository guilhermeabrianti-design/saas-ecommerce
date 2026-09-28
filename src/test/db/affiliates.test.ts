// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { approveCatalog, asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerAdmin: string;
let sellerMember: string;
let supplier: string;
let admin: string;
let sellerOrg: string;
let supplierOrg: string;
let imported: string;
let importedVariant: string;

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

async function rows<T = Record<string, unknown>>(
  userId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return asUser(db, userId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0]!;
}

const buyer = {
  customer_name: 'Maria Compradora',
  customer_email: 'maria@example.com',
  customer_phone: '11987654321',
  customer_document: '12345678909',
  ship_postal_code: '01310100',
  ship_street: 'Av. Paulista',
  ship_number: '1000',
  ship_district: 'Bela Vista',
  ship_city: 'São Paulo',
  ship_state: 'SP',
};

const hash = (n: number) => n.toString(16).padStart(64, '0');
let nextPaymentId = 7000;

/** Pedido do checkout (opcionalmente atribuído) e, se `approve`, pagamento aprovado. */
async function sale(opts: { store?: string; link?: string; approve?: boolean } = {}) {
  const created = await service<{ order_id: string; total_cents: number }>(
    'select public.checkout_create_order($1, $2, 1, $3, $4)',
    [imported, importedVariant, JSON.stringify(buyer), crypto.randomUUID()],
  );
  const attributed = await service<boolean>('select public.checkout_attribute_order($1, $2, $3)', [
    created.order_id,
    opts.store ?? null,
    opts.link ?? null,
  ]);
  const payment = {
    external_id: String(nextPaymentId++),
    external_reference: created.order_id,
    status: 'approved',
    status_detail: 'accredited',
    method: 'pix',
    amount_cents: created.total_cents,
    fee_cents: 300,
  };
  if (opts.approve !== false) {
    await service('select public.checkout_sync_payment($1)', [JSON.stringify(payment)]);
  } else {
    // Pagamento criado no Mercado Pago, ainda pendente.
    await service('select public.checkout_sync_payment($1)', [
      JSON.stringify({ ...payment, status: 'pending' }),
    ]);
  }
  return { orderId: created.order_id, payment, attributed };
}

const refund = (payment: Record<string, unknown>) =>
  service('select public.checkout_sync_payment($1)', [
    JSON.stringify({ ...payment, status: 'refunded' }),
  ]);

const code = (org: string) =>
  one<{ public_code: string }>('select public_code from public.organizations where id = $1', [
    org,
  ]).then((r) => r.public_code);

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  sellerAdmin = await signUpUser(db, 'adm@example.com', { full_name: 'Admin da loja' });
  sellerMember = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Forn',
    account_type: 'supplier',
  });
  admin = await signUpUser(db, 'staff@example.com', { full_name: 'Equipe' });
  await db.query("update public.profiles set role = 'admin' where id = $1", [admin]);

  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  supplierOrg = await scalar(supplier, "select public.create_organization('Fábrica X')");
  for (const [user, email, role] of [
    [sellerAdmin, 'adm@example.com', 'admin'],
    [sellerMember, 'membro@example.com', 'member'],
  ] as const) {
    const inv = await scalar<string>(seller, 'select public.invite_member($1, $2, $3)', [
      sellerOrg,
      email,
      role,
    ]);
    await scalar(user, 'select public.accept_invitation($1)', [inv]);
  }

  const sp = await scalar<string>(
    supplier,
    "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, 'CAM', 'Camiseta', 9000, 'active') returning id",
    [supplierOrg],
  );
  const sv = await scalar<string>(
    supplier,
    `insert into public.product_variants (organization_id, product_id, sku, attributes)
     values ($1, $2, 'CAM-AZ', '{"Cor":"Azul"}') returning id`,
    [supplierOrg, sp],
  );
  const supplierItem = await scalar<string>(
    supplier,
    'select id from public.inventory_items where variant_id = $1',
    [sv],
  );
  await scalar(
    supplier,
    "select public.adjust_stock($1, 50, 'purchase', null, gen_random_uuid())",
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
  importedVariant = await scalar(
    seller,
    'select id from public.product_variants where product_id = $1',
    [imported],
  );
  await scalar(seller, 'update public.product_variants set price_cents = null where id = $1', [
    importedVariant,
  ]);
  await scalar(seller, 'select public.set_product_checkout($1, true)', [imported]);
});

afterEach(async () => {
  await db.close();
});

describe('código público da organização', () => {
  it('nasce gerado e o owner troca, com validação e unicidade', async () => {
    expect(await code(sellerOrg)).toMatch(/^[a-z0-9]{8}$/);
    expect(await code(supplierOrg)).not.toBe(await code(sellerOrg));

    expect(
      await scalar(seller, "select public.set_public_code($1, ' Loja-Da-Ana ')", [sellerOrg]),
    ).toBe('loja-da-ana');
    for (const bad of ['ab', 'a--b', '-abc', 'com espaço', 'ação']) {
      await expect(
        scalar(seller, 'select public.set_public_code($1, $2)', [sellerOrg, bad]),
      ).rejects.toThrow(/affiliates.invalid_code/);
    }
    await expect(
      scalar(supplier, "select public.set_public_code($1, 'loja-da-ana')", [supplierOrg]),
    ).rejects.toThrow(/affiliates.code_taken/);
    await expect(
      scalar(supplier, "select public.set_public_code($1, 'admin')", [supplierOrg]),
    ).rejects.toThrow(/affiliates.code_taken/);
    await expect(
      scalar(sellerAdmin, "select public.set_public_code($1, 'outra-loja')", [sellerOrg]),
    ).rejects.toThrow(/affiliates.forbidden/);
    await expect(
      scalar(seller, "update public.organizations set public_code = 'xyzw' where id = $1", [
        sellerOrg,
      ]),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('links de divulgação', () => {
  it('owner/admin criam; código gerado ou próprio; regras de produto e papel', async () => {
    const generated = await scalar<string>(
      sellerAdmin,
      "select public.create_affiliate_link($1, 'Bio do Instagram', null, $2)",
      [sellerOrg, imported],
    );
    expect(
      await one('select code, product_id from public.affiliate_links where id = $1', [generated]),
    ).toMatchObject({ product_id: imported });

    await scalar(seller, "select public.create_affiliate_link($1, 'Live', 'Live-Sexta', null)", [
      sellerOrg,
    ]);
    await expect(
      scalar(seller, "select public.create_affiliate_link($1, 'Outra', 'live-sexta', null)", [
        sellerOrg,
      ]),
    ).rejects.toThrow(/affiliates.code_taken/);
    await expect(
      scalar(seller, "select public.create_affiliate_link($1, 'X', null, null)", [sellerOrg]),
    ).rejects.toThrow(/affiliates.invalid_name/);

    const supplierProduct = await one<{ id: string }>(
      'select id from public.products where organization_id = $1',
      [supplierOrg],
    );
    await expect(
      scalar(seller, "select public.create_affiliate_link($1, 'Alheio', null, $2)", [
        sellerOrg,
        supplierProduct.id,
      ]),
    ).rejects.toThrow(/affiliates.invalid_product/);
    await expect(
      scalar(sellerMember, "select public.create_affiliate_link($1, 'Membro', null, null)", [
        sellerOrg,
      ]),
    ).rejects.toThrow(/affiliates.forbidden/);
    await expect(
      scalar(supplier, "select public.create_affiliate_link($1, 'Fornecedor', null, null)", [
        supplierOrg,
      ]),
    ).rejects.toThrow(/affiliates.forbidden/);

    // Membros leem; outras organizações não; ninguém grava direto.
    expect(await scalar(sellerMember, 'select count(*)::int from public.affiliate_links')).toBe(2);
    expect(await scalar(supplier, 'select count(*)::int from public.affiliate_links')).toBe(0);
    await expect(
      scalar(seller, "update public.affiliate_links set code = 'hack' where id = $1", [generated]),
    ).rejects.toThrow(/permission denied/);

    await scalar(seller, "select public.update_affiliate_link($1, 'Bio', false)", [generated]);
    expect(
      await one('select name, is_active from public.affiliate_links where id = $1', [generated]),
    ).toEqual({ name: 'Bio', is_active: false });
    await expect(
      scalar(sellerMember, "select public.update_affiliate_link($1, 'Bio', true)", [generated]),
    ).rejects.toThrow(/affiliates.not_found/);
  });
});

describe('vitrine e visitas (service role)', () => {
  it('vitrine lista só produtos do checkout de vendedor ativo', async () => {
    const store = await service<{ store_name: string; products: { product_id: string }[] }>(
      'select public.store_public($1)',
      [(await code(sellerOrg)).toUpperCase()],
    );
    expect(store.store_name).toBe('Loja V');
    expect(store.products.map((p) => p.product_id)).toEqual([imported]);
    expect(store.products[0]).toMatchObject({ price_cents: 5990, has_variants: true });

    expect(await service('select public.store_public($1)', [await code(supplierOrg)])).toBeNull();
    await scalar(seller, 'select public.set_product_checkout($1, false)', [imported]);
    expect(
      (
        await service<{ products: unknown[] }>('select public.store_public($1)', [
          await code(sellerOrg),
        ])
      ).products,
    ).toEqual([]);

    await db.query(
      "update public.organizations set suspended_at = now(), suspension_reason = 'Teste' where id = $1",
      [sellerOrg],
    );
    expect(await service('select public.store_public($1)', [await code(sellerOrg)])).toBeNull();
  });

  it('conta cliques e visitas por visitante/dia; link pausado ou desconhecido não conta', async () => {
    const link = await scalar<string>(
      seller,
      "select public.create_affiliate_link($1, 'Stories', 'stories', $2)",
      [sellerOrg, imported],
    );
    expect(await service('select public.affiliate_link_target($1)', ['STORIES'])).toEqual({
      link_code: 'stories',
      store_code: await code(sellerOrg),
      product_id: imported,
    });

    for (const visitor of [1, 1, 1, 2]) {
      await service("select public.affiliate_record_visit(null, 'stories', $1)", [hash(visitor)]);
    }
    await service('select public.affiliate_record_visit($1, null, $2)', [
      await code(sellerOrg),
      hash(1),
    ]);
    await service("select public.affiliate_record_visit(null, 'nao-existe', $1)", [hash(3)]);
    await expect(
      service("select public.affiliate_record_visit(null, 'stories', 'abc')"),
    ).rejects.toThrow(/affiliates.invalid/);

    await scalar(seller, "select public.update_affiliate_link($1, 'Stories', false)", [link]);
    await service("select public.affiliate_record_visit(null, 'stories', $1)", [hash(4)]);
    expect(await service('select public.affiliate_link_target($1)', ['stories'])).toBeNull();

    const stats = await rows<{ kind: string; clicks: number; visits: number }>(
      seller,
      'select kind, clicks::int, visits::int from public.affiliate_stats($1, 30)',
      [sellerOrg],
    );
    expect(stats).toEqual([
      { kind: 'store', clicks: 1, visits: 1 },
      { kind: 'link', clicks: 4, visits: 2 },
      { kind: 'direct', clicks: null, visits: null },
    ]);
  });

  it('anon e contas conectadas não chamam as funções públicas nem leem visitas', async () => {
    await expect(scalar(null, "select public.store_public('abcd')")).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      scalar(seller, "select public.affiliate_record_visit(null, 'abcd', $1)", [hash(1)]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      scalar(seller, 'select public.checkout_attribute_order($1, null, null)', [imported]),
    ).rejects.toThrow(/permission denied/);
    await expect(scalar(seller, 'select count(*) from public.affiliate_visits')).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('vendas atribuídas', () => {
  it('atribui por link da própria loja ou pela vitrine e soma no desempenho', async () => {
    const link = await scalar<string>(
      seller,
      "select public.create_affiliate_link($1, 'WhatsApp', 'whats', $2)",
      [sellerOrg, imported],
    );
    const byLink = await sale({ link: 'whats', store: await code(sellerOrg) });
    const byStore = await sale({ store: await code(sellerOrg) });
    const direct = await sale();
    const pendingByLink = await sale({ link: 'whats', approve: false });
    expect([byLink.attributed, byStore.attributed, direct.attributed]).toEqual([true, true, false]);
    expect(
      await one('select source, link_id from public.order_attributions where order_id = $1', [
        byLink.orderId,
      ]),
    ).toEqual({ source: 'link', link_id: link });
    expect(pendingByLink.attributed).toBe(true);

    // Link de outra loja não vale.
    await db.query(
      "insert into public.affiliate_links (organization_id, code, name) values ($1, 'alheio', 'Alheio')",
      [supplierOrg],
    );
    expect((await sale({ link: 'alheio' })).attributed).toBe(false);

    // A primeira origem registrada vale.
    expect(
      await service('select public.checkout_attribute_order($1, $2, null)', [
        byLink.orderId,
        await code(sellerOrg),
      ]),
    ).toBe(true);
    expect(
      await one('select source from public.order_attributions where order_id = $1', [
        byLink.orderId,
      ]),
    ).toEqual({ source: 'link' });

    // Estorno sai das vendas pagas.
    await refund(byStore.payment);

    const stats = await rows<Record<string, unknown>>(
      seller,
      `select kind, code, orders::int, paid_orders::int, sales_cents::int, commission_cents::int
       from public.affiliate_stats($1, 7)`,
      [sellerOrg],
    );
    expect(stats).toEqual([
      expect.objectContaining({ kind: 'store', orders: 1, paid_orders: 0, sales_cents: 0 }),
      {
        kind: 'link',
        code: 'whats',
        orders: 2,
        paid_orders: 1,
        sales_cents: 5990,
        commission_cents: 899,
      },
      expect.objectContaining({ kind: 'direct', orders: 2, paid_orders: 2, sales_cents: 11980 }),
    ]);

    await expect(
      scalar(sellerMember, 'select count(*) from public.affiliate_stats($1, 30)', [sellerOrg]),
    ).rejects.toThrow(/org.forbidden/);
    expect(await scalar(sellerMember, 'select count(*)::int from public.order_attributions')).toBe(
      0,
    );
    expect(await scalar(sellerAdmin, 'select count(*)::int from public.order_attributions')).toBe(
      3,
    );
  });
});

describe('indicação', () => {
  let friend: string;

  const enable = (reward = 500, minSale = 0, days = 90) =>
    scalar(admin, 'select public.admin_save_referral_settings(true, $1, $2, $3)', [
      reward,
      minSale,
      days,
    ]);

  const wallet = (user: string, org: string) =>
    scalar<{ pending_cents: number; available_cents: number }>(
      user,
      'select public.wallet_summary($1)',
      [org],
    );

  beforeEach(async () => {
    friend = await signUpUser(db, 'amiga@example.com', { full_name: 'Amiga' });
  });

  it('programa desligado recusa o código; só a equipe altera as regras', async () => {
    await expect(
      scalar(friend, "select public.create_organization('Loja Amiga', $1)", [
        await code(sellerOrg),
      ]),
    ).rejects.toThrow(/referral.disabled/);
    // Nada foi criado (atômico).
    expect(
      await one("select count(*)::int as n from public.organizations where name = 'Loja Amiga'"),
    ).toEqual({ n: 0 });

    await expect(
      scalar(seller, 'select public.admin_save_referral_settings(true, 500, 0, 90)'),
    ).rejects.toThrow(/admin.forbidden/);
    await expect(
      scalar(admin, 'select public.admin_save_referral_settings(true, 0, 0, 90)'),
    ).rejects.toThrow(/referral.invalid_settings/);
    await enable();
    expect(
      await one(
        "select count(*)::int as n from public.admin_audit_log where action = 'referral.settings'",
      ),
    ).toEqual({ n: 1 });
  });

  it('recusa código inválido, autoindicação e segunda indicação', async () => {
    await enable();
    await expect(
      scalar(friend, "select public.create_organization('Loja Amiga', 'nao-existe')"),
    ).rejects.toThrow(/referral.invalid_code/);
    // O mesmo usuário não indica a si mesmo com outra organização.
    await expect(
      scalar(seller, "select public.create_organization('Loja 2', $1)", [await code(sellerOrg)]),
    ).rejects.toThrow(/referral.self/);

    const friendOrg = await scalar<string>(
      friend,
      "select public.create_organization('Loja Amiga')",
    );
    // Membro em comum também é autoindicação.
    const inv = await scalar<string>(
      friend,
      "select public.invite_member($1, 'membro@example.com', 'member')",
      [friendOrg],
    );
    await scalar(sellerMember, 'select public.accept_invitation($1)', [inv]);
    await expect(
      scalar(friend, 'select public.apply_referral_code($1, $2)', [
        friendOrg,
        await code(sellerOrg),
      ]),
    ).rejects.toThrow(/referral.self/);

    await scalar(friend, 'select public.apply_referral_code($1, $2)', [
      friendOrg,
      await code(supplierOrg),
    ]);
    await expect(
      scalar(friend, 'select public.apply_referral_code($1, $2)', [
        friendOrg,
        await code(supplierOrg),
      ]),
    ).rejects.toThrow(/referral.already_referred/);
    await expect(
      scalar(sellerAdmin, 'select public.apply_referral_code($1, $2)', [
        sellerOrg,
        await code(supplierOrg),
      ]),
    ).rejects.toThrow(/referral.forbidden/);
  });

  it('primeira venda paga da indicada credita quem indicou; estorno desfaz', async () => {
    // O fornecedor indicou esta loja: a venda da loja gera a recompensa.
    await enable(500, 1000, 90);
    await db.query('delete from public.organization_referrals');
    await db.query(
      `insert into public.organization_referrals (referred_org_id, referrer_org_id, reward_cents, min_sale_cents, expires_at)
       values ($1, $2, 500, 1000, now() + interval '90 days')`,
      [sellerOrg, supplierOrg],
    );

    const first = await sale();
    // Fornecedor: atacado 2000 + recompensa 500, ambos pendentes pelo mesmo pedido.
    expect(await wallet(supplier, supplierOrg)).toMatchObject({ pending_cents: 2500 });
    expect(
      await one(
        "select sum(amount_cents)::int as total from public.platform_ledger_entries where kind = 'referral_reward'",
      ),
    ).toEqual({ total: -500 });
    expect(
      await one(
        'select reward_order_id from public.organization_referrals where referred_org_id = $1',
        [sellerOrg],
      ),
    ).toEqual({ reward_order_id: first.orderId });

    // Segunda venda: sem nova recompensa.
    await sale();
    expect(await wallet(supplier, supplierOrg)).toMatchObject({ pending_cents: 4500 });

    // Estorno do pedido premiado: recompensa desfeita; a próxima venda volta a valer.
    await refund(first.payment);
    expect(await wallet(supplier, supplierOrg)).toMatchObject({ pending_cents: 2000 });
    expect(
      await one(
        'select sum(amount_cents)::int as total from public.platform_ledger_entries where kind in ($1, $2)',
        ['referral_reward', 'referral_reversal'],
      ),
    ).toEqual({ total: 0 });
    await sale();
    expect(await wallet(supplier, supplierOrg)).toMatchObject({ pending_cents: 4500 });

    const summary = await scalar<{ earned_cents: number; referrals: { status: string }[] }>(
      supplier,
      'select public.referral_summary($1)',
      [supplierOrg],
    );
    expect(summary.earned_cents).toBe(500);
    expect(summary.referrals).toEqual([
      expect.objectContaining({ name: 'Loja V', status: 'rewarded' }),
    ]);
    const referred = await scalar<{ referred_by: { name: string }; can_apply: boolean }>(
      seller,
      'select public.referral_summary($1)',
      [sellerOrg],
    );
    expect(referred).toMatchObject({ referred_by: { name: 'Fábrica X' }, can_apply: false });
    await expect(
      scalar(sellerMember, 'select public.referral_summary($1)', [sellerOrg]),
    ).rejects.toThrow(/org.forbidden/);

    const list = await rows<{ status: string; reward_order_number: number }>(
      admin,
      'select status, reward_order_number from public.admin_referrals(50, 0)',
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe('rewarded');
  });

  it('venda abaixo do mínimo, prazo vencido ou quem indicou suspenso não geram recompensa', async () => {
    await enable();
    for (const [minSale, expires] of [
      [10000, "now() + interval '1 day'"],
      [0, "now() - interval '1 day'"],
    ] as const) {
      await db.query('delete from public.organization_referrals');
      await db.query(
        `insert into public.organization_referrals (referred_org_id, referrer_org_id, reward_cents, min_sale_cents, expires_at)
         values ($1, $2, 500, $3, ${expires})`,
        [sellerOrg, supplierOrg, minSale],
      );
      await sale();
    }
    // Quem indicou está suspenso.
    const friendOrg = await scalar<string>(
      friend,
      "select public.create_organization('Loja Amiga')",
    );
    await db.query('delete from public.organization_referrals');
    await db.query(
      `insert into public.organization_referrals (referred_org_id, referrer_org_id, reward_cents, min_sale_cents, expires_at)
       values ($1, $2, 500, 0, now() + interval '1 day')`,
      [sellerOrg, friendOrg],
    );
    await db.query(
      "update public.organizations set suspended_at = now(), suspension_reason = 'Teste' where id = $1",
      [friendOrg],
    );
    await sale();
    expect(
      await one(
        "select count(*)::int as n from public.ledger_entries where kind = 'referral_reward'",
      ),
    ).toEqual({ n: 0 });
  });

  it('indicação registrada pela criação congela a regra; fornecedor indicado também conta', async () => {
    await enable(700, 0, 30);
    const friendOrg = await scalar<string>(
      friend,
      "select public.create_organization('Loja Amiga', $1)",
      [` ${(await code(sellerOrg)).toUpperCase()} `],
    );
    await enable(100, 0, 30);
    expect(
      await one(
        'select referrer_org_id, reward_cents from public.organization_referrals where referred_org_id = $1',
        [friendOrg],
      ),
    ).toEqual({ referrer_org_id: sellerOrg, reward_cents: 700 });

    // A loja indicou o fornecedor desta venda: o fornecimento pago conta como primeira venda dele.
    await db.query(
      `insert into public.organization_referrals (referred_org_id, referrer_org_id, reward_cents, min_sale_cents, expires_at)
       values ($1, $2, 300, 0, now() + interval '1 day')`,
      [supplierOrg, friendOrg],
    );
    await sale();
    expect(
      await one(
        "select organization_id, amount_cents::int from public.ledger_entries where kind = 'referral_reward'",
      ),
    ).toEqual({ organization_id: friendOrg, amount_cents: 300 });
  });
});
