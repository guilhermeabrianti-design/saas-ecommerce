// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerMember: string;
let seller2: string;
let supplier: string;
let admin: string;
let sellerOrg: string;
let seller2Org: string;
let supplierOrg: string;
let orderNumber = 0;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

const rows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

type Summary = {
  total: number;
  month: number;
  level: { name: string; min_points: number } | null;
  next_level: { name: string; min_points: number } | null;
  show_in_ranking: boolean;
  rules: { event: string; points: number }[];
  achievements: { code: string; progress: number; threshold: number; earned_at: string | null }[];
  recent: { event: string; label: string; points: number }[];
};

const summary = (user: string, org: string) =>
  scalar<Summary>(user, 'select public.gamification_summary($1)', [org]);

/** Pedido do vendedor (direto no banco: o teste é dos gatilhos). */
async function order(org: string, channel: 'manual' | 'checkout' | 'marketplace' = 'checkout') {
  orderNumber += 1;
  const res = await db.query<{ id: string }>(
    `insert into public.orders (organization_id, number, request_id, customer_name, ship_postal_code,
       ship_street, ship_number, ship_district, ship_city, ship_state, subtotal_cents, total_cents, channel)
     values ($1, $2, gen_random_uuid(), 'Cliente', '01310100', 'Av. Paulista', '1', 'Centro',
       'São Paulo', 'SP', 1000, 1000, $3) returning id`,
    [org, orderNumber, channel],
  );
  return res.rows[0]!.id;
}

const deliver = (id: string) =>
  db.query("update public.orders set status = 'delivered' where id = $1", [id]);

beforeEach(async () => {
  db = await createTestDatabase();
  orderNumber = 0;
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  sellerMember = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
  seller2 = await signUpUser(db, 'vend2@example.com', { full_name: 'Vendedor Dois' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Forn',
    account_type: 'supplier',
  });
  admin = await signUpUser(db, 'staff@example.com', { full_name: 'Equipe' });
  await db.query("update public.profiles set role = 'admin' where id = $1", [admin]);
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  seller2Org = await scalar(seller2, "select public.create_organization('Loja Dois')");
  supplierOrg = await scalar(supplier, "select public.create_organization('Fábrica X')");
  const inv = await scalar<string>(
    seller,
    "select public.invite_member($1, 'membro@example.com', 'member')",
    [sellerOrg],
  );
  await scalar(sellerMember, 'select public.accept_invitation($1)', [inv]);
});

afterEach(async () => {
  await db.close();
});

describe('pontos por eventos reais', () => {
  it('venda entregue do checkout ou marketplace pontua; manual não; cancelada estorna', async () => {
    const a = await order(sellerOrg, 'checkout');
    const b = await order(sellerOrg, 'marketplace');
    const manual = await order(sellerOrg, 'manual');
    await deliver(a);
    await deliver(b);
    await deliver(manual);
    // Atualizar de novo não pontua duas vezes.
    await db.query("update public.orders set notes = 'x' where id = $1", [a]);

    let s = await summary(sellerMember, sellerOrg);
    expect(s.total).toBe(20);
    expect(s.month).toBe(20);
    expect(s.level).toEqual({ name: 'Iniciante', min_points: 0 });
    expect(s.next_level).toEqual({ name: 'Bronze', min_points: 100 });
    expect(s.achievements.find((x) => x.code === 'first_sale')).toMatchObject({
      progress: 1,
      threshold: 1,
    });
    expect(s.achievements.find((x) => x.code === 'first_sale')!.earned_at).not.toBeNull();
    expect(s.achievements.find((x) => x.code === 'sales_10')).toMatchObject({
      progress: 2,
      earned_at: null,
    });
    // Conquistas de fornecedor não aparecem para vendedor.
    expect(s.achievements.some((x) => x.code === 'first_shipment')).toBe(false);
    expect(
      await rows(
        "select kind, title from public.notifications where user_id = $1 and kind like 'gamification.%'",
        [sellerMember],
      ),
    ).toEqual([{ kind: 'gamification.achievement', title: 'Conquista: Primeira venda' }]);

    await db.query("update public.orders set status = 'cancelled' where id = $1", [a]);
    s = await summary(seller, sellerOrg);
    expect(s.total).toBe(10);
    expect(s.recent[0]).toMatchObject({ event: 'sale_delivered', points: -10 });
  });

  it('sobe de nível com aviso; limite diário da regra', async () => {
    for (let i = 0; i < 10; i += 1) await deliver(await order(sellerOrg));
    const s = await summary(seller, sellerOrg);
    expect(s.total).toBe(100);
    expect(s.level?.name).toBe('Bronze');
    expect(
      await rows(
        "select title from public.notifications where user_id = $1 and kind = 'gamification.level'",
        [seller],
      ),
    ).toEqual([{ title: 'Novo nível: Bronze' }]);

    await scalar(
      admin,
      "select public.admin_save_gamification_rule('sale_delivered', 10, 2, true)",
    );
    for (let i = 0; i < 3; i += 1) await deliver(await order(seller2Org));
    expect((await summary(seller2, seller2Org)).total).toBe(20);
  });

  it('fornecedor, avaliação, aula, catálogo, Mercado Livre e indicação', async () => {
    // Envio de pedido real pelo fornecedor.
    const o = await order(sellerOrg, 'checkout');
    const so = (
      await db.query<{ id: string }>(
        `insert into public.supplier_orders (organization_id, seller_organization_id, order_id, number,
           recipient_name, ship_postal_code, ship_street, ship_number, ship_district, ship_city, ship_state, total_wholesale_cents)
         values ($1, $2, $3, 1, 'Cliente', '01310100', 'Av', '1', 'Centro', 'SP', 'SP', 500) returning id`,
        [supplierOrg, sellerOrg, o],
      )
    ).rows[0]!.id;
    await db.query("update public.supplier_orders set status = 'shipped' where id = $1", [so]);

    // Catálogo: publicar, despublicar e publicar de novo pontua uma vez só.
    const sp = await scalar<string>(
      supplier,
      "insert into public.products (organization_id, sku, name, price_cents) values ($1, 'P1', 'Produto', 100) returning id",
      [supplierOrg],
    );
    const listing = (
      await db.query<{ id: string }>(
        'insert into public.catalog_listings (organization_id, product_id, wholesale_price_cents, is_published) values ($1, $2, 50, true) returning id',
        [supplierOrg, sp],
      )
    ).rows[0]!.id;
    await db.query('update public.catalog_listings set is_published = false where id = $1', [
      listing,
    ]);
    await db.query('update public.catalog_listings set is_published = true where id = $1', [
      listing,
    ]);

    // Avaliação 5 estrelas; ocultada pela equipe, estorna.
    const review = (
      await db.query<{ id: string }>(
        "insert into public.reviews (target_org_id, source, supplier_order_id, reviewer_org_id, reviewer_label, rating) values ($1, 'seller', $2, $3, 'Vendedor verificado', 5) returning id",
        [supplierOrg, so, sellerOrg],
      )
    ).rows[0]!.id;
    let s = await summary(supplier, supplierOrg);
    expect(s.total).toBe(10 + 5 + 5);
    await db.query(
      "update public.reviews set hidden_at = now(), hidden_reason = 'abusiva' where id = $1",
      [review],
    );
    s = await summary(supplier, supplierOrg);
    expect(s.total).toBe(15);
    expect(s.achievements.find((x) => x.code === 'first_shipment')!.earned_at).not.toBeNull();

    // Aula concluída (uma vez por aula) e venda entregue não valem para fornecedor.
    const course = (
      await db.query<{ id: string }>(
        "insert into public.academy_courses (title, status) values ('Curso', 'published') returning id",
      )
    ).rows[0]!.id;
    const mod = (
      await db.query<{ id: string }>(
        "insert into public.academy_modules (course_id, title) values ($1, 'Módulo') returning id",
        [course],
      )
    ).rows[0]!.id;
    const lesson = (
      await db.query<{ id: string }>(
        "insert into public.academy_lessons (course_id, module_id, title, youtube_id) values ($1, $2, 'Aula um', 'dQw4w9WgXcQ') returning id",
        [course, mod],
      )
    ).rows[0]!.id;
    await db.query(
      'insert into public.academy_progress (user_id, lesson_id, percent, completed_at) values ($1, $2, 100, now())',
      [sellerMember, lesson],
    );
    await db.query('update public.academy_progress set completed_at = now() where user_id = $1', [
      sellerMember,
    ]);

    // Anúncio publicado no Mercado Livre.
    const product = await scalar<string>(
      seller,
      "insert into public.products (organization_id, sku, name, price_cents) values ($1, 'CAM', 'Camiseta', 8990) returning id",
      [sellerOrg],
    );
    await scalar(
      seller,
      "select public.save_product_channel_config($1, 'mercadolivre', true, 'Camiseta', 8990, 'classico', null, 'MLB1', true)",
      [product],
    );
    await db.query("update public.product_channel_configs set external_id = 'MLB123'");

    // Indicação que gerou recompensa (e estorno).
    await db.query(
      `insert into public.organization_referrals (referred_org_id, referrer_org_id, reward_cents, min_sale_cents, expires_at)
       values ($1, $2, 500, 0, now() + interval '90 days')`,
      [seller2Org, sellerOrg],
    );
    await db.query(
      'update public.organization_referrals set rewarded_at = now(), reward_order_id = $1',
      [o],
    );

    s = await summary(seller, sellerOrg);
    expect(s.total).toBe(3 + 5 + 50);
    await db.query(
      'update public.organization_referrals set rewarded_at = null, reward_order_id = null',
    );
    expect((await summary(seller, sellerOrg)).total).toBe(8);
  });

  it('livro de pontos é imutável e fechado para a API', async () => {
    await deliver(await order(sellerOrg));
    await expect(db.query('update public.gamification_points set points = 999')).rejects.toThrow(
      /gamification.immutable/,
    );
    await expect(db.query('delete from public.gamification_points')).rejects.toThrow(
      /gamification.immutable/,
    );
    for (const table of [
      'gamification_points',
      'gamification_rules',
      'organization_achievements',
    ]) {
      await expect(scalar(seller, `select count(*) from public.${table}`)).rejects.toThrow(
        /permission denied/,
      );
    }
    await expect(summary(seller2, sellerOrg)).rejects.toThrow(/org.forbidden/);
  });
});

describe('ranking', () => {
  it('mês por tipo de conta; nome só de quem escolheu aparecer', async () => {
    await deliver(await order(sellerOrg));
    await deliver(await order(seller2Org));
    await deliver(await order(seller2Org));

    type Ranking = {
      top: { position: number; name: string; points: number; is_me: boolean }[];
      me: { position: number; points: number } | null;
    };
    const ranking = (user: string, org: string) =>
      scalar<Ranking>(user, 'select public.gamification_ranking($1)', [org]);

    let r = await ranking(seller, sellerOrg);
    expect(r.top).toEqual([
      { position: 1, name: 'Loja anônima', points: 20, is_me: false },
      { position: 2, name: 'Loja V', points: 10, is_me: true },
    ]);
    expect(r.me).toEqual({ position: 2, points: 10 });

    await expect(
      scalar(sellerMember, 'select public.set_ranking_visibility($1, true)', [sellerOrg]),
    ).rejects.toThrow(/org.forbidden/);
    await scalar(seller2, 'select public.set_ranking_visibility($1, true)', [seller2Org]);
    r = await ranking(seller, sellerOrg);
    expect(r.top[0]!.name).toBe('Loja Dois');

    // Fornecedor não aparece entre vendedores e vê só fornecedores.
    r = await ranking(supplier, supplierOrg);
    expect(r).toEqual(expect.objectContaining({ top: [], me: null }));
  });
});

describe('equipe', () => {
  it('só a equipe configura; regras, níveis e conquistas validados e auditados', async () => {
    await expect(scalar(seller, 'select public.admin_gamification_config()')).rejects.toThrow(
      /admin.forbidden/,
    );
    await expect(
      scalar(seller, "select public.admin_save_gamification_rule('sale_delivered', 1, null, true)"),
    ).rejects.toThrow(/admin.forbidden/);

    const config = await scalar<{ rules: unknown[]; levels: unknown[]; achievements: unknown[] }>(
      admin,
      'select public.admin_gamification_config()',
    );
    expect(config.rules).toHaveLength(7);
    expect(config.levels).toHaveLength(5);

    await expect(
      scalar(admin, "select public.admin_save_gamification_rule('sale_delivered', -1, null, true)"),
    ).rejects.toThrow(/gamification.invalid/);
    await expect(
      scalar(admin, "select public.admin_save_gamification_rule('inventado', 1, null, true)"),
    ).rejects.toThrow(/gamification.not_found/);

    // Regra desligada não pontua.
    await scalar(
      admin,
      "select public.admin_save_gamification_rule('sale_delivered', 10, null, false)",
    );
    await deliver(await order(sellerOrg));
    expect((await summary(seller, sellerOrg)).total).toBe(0);

    for (const bad of [
      [],
      [{ name: 'A', min_points: 0 }],
      [{ name: 'Início', min_points: 10 }],
      [
        { name: 'Início', min_points: 0 },
        { name: 'Outro', min_points: 0 },
      ],
    ]) {
      await expect(
        scalar(admin, 'select public.admin_save_gamification_levels($1)', [JSON.stringify(bad)]),
      ).rejects.toThrow(/gamification.invalid_levels/);
    }
    await scalar(admin, 'select public.admin_save_gamification_levels($1)', [
      JSON.stringify([
        { name: 'Pro', min_points: 50 },
        { name: 'Novo', min_points: 0 },
      ]),
    ]);
    expect(await rows('select position, name, min_points from public.gamification_levels')).toEqual(
      [
        { position: 1, name: 'Novo', min_points: 0 },
        { position: 2, name: 'Pro', min_points: 50 },
      ],
    );

    await scalar(
      admin,
      "select public.admin_save_achievement('sales_10', 'Dez vendas', 'Entregou 10 vendas.', 5, false)",
    );
    expect(
      await rows(
        "select threshold, active from public.gamification_achievements where code = 'sales_10'",
      ),
    ).toEqual([{ threshold: 5, active: false }]);
    expect(
      await rows(
        "select action from public.admin_audit_log where action like 'gamification.%' order by created_at",
      ),
    ).toEqual([
      { action: 'gamification.rule' },
      { action: 'gamification.levels' },
      { action: 'gamification.achievement' },
    ]);
  });
});
