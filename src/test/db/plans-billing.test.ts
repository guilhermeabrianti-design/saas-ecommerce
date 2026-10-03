// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerAdmin: string;
let supplier: string;
let admin: string;
let sellerOrg: string;
let supplierOrg: string;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

/** Como a Edge Function (service role). */
async function service<T>(sql: string, params: unknown[] = []): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec('set local role service_role');
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

type Overview = {
  plan: { id: string; name: string; max_products: number | null; featured_slots: number };
  usage: { products: number; ai_daily_limit: number; featured: number };
  can_manage: boolean;
  current: { status: string; plan_name: string; access_until: string | null } | null;
  pending: { plan_id: string; checkout_url: string | null } | null;
  plans: { id: string; name: string }[];
  payments: { external_id: string; payment_status: string | null }[];
};

const overview = (user: string, org: string) =>
  scalar<Overview>(user, 'select public.billing_overview($1)', [org]);

async function createPlan(
  kind: 'seller' | 'supplier',
  name: string,
  price: number,
  opts: { ai?: number | null; maxProducts?: number | null; featured?: number } = {},
) {
  return scalar<string>(
    admin,
    'select public.admin_save_plan(null, $1, $2, null, $3, $4, $5, $6, true, 1::smallint)',
    [kind, name, price, opts.ai ?? null, opts.maxProducts ?? null, opts.featured ?? 0],
  );
}

/** Assina pelo fluxo real: começa como dono, anexa e autoriza como a Edge Function. */
async function subscribe(user: string, org: string, plan: string, externalId: string) {
  const begun = await scalar<{ subscription_id: string; price_cents: number }>(
    user,
    'select public.billing_begin_subscription($1, $2)',
    [org, plan],
  );
  await service('select public.billing_attach_checkout($1, $2, $3)', [
    begun.subscription_id,
    externalId,
    `https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=${externalId}`,
  ]);
  return begun;
}

const sync = (externalId: string, status: string, amount: number, next: string | null = null) =>
  service<{ action: string; cancel: string[] }>('select public.billing_sync_subscription($1)', [
    JSON.stringify({
      external_id: externalId,
      external_reference: null,
      status,
      amount_cents: amount,
      next_payment_at: next,
    }),
  ]);

async function product(user: string, org: string, sku: string, status = 'active') {
  return scalar<string>(
    user,
    'insert into public.products (organization_id, sku, name, price_cents, status) values ($1, $2, $3, 5000, $4) returning id',
    [org, sku, `Produto ${sku}`, status],
  );
}

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  sellerAdmin = await signUpUser(db, 'adm@example.com', { full_name: 'Admin da loja' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Forn',
    account_type: 'supplier',
  });
  admin = await signUpUser(db, 'staff@example.com', { full_name: 'Equipe' });
  await db.query("update public.profiles set role = 'admin' where id = $1", [admin]);
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  supplierOrg = await scalar(supplier, "select public.create_organization('Fábrica X')");
  const inv = await scalar<string>(
    seller,
    "select public.invite_member($1, 'adm@example.com', 'admin')",
    [sellerOrg],
  );
  await scalar(sellerAdmin, 'select public.accept_invitation($1)', [inv]);
});

afterEach(async () => {
  await db.close();
});

describe('planos', () => {
  it('toda empresa começa no gratuito do seu tipo; só a equipe cria planos', async () => {
    const o = await overview(sellerAdmin, sellerOrg);
    expect(o.plan).toMatchObject({ name: 'Grátis', max_products: null, featured_slots: 0 });
    expect(o.usage.ai_daily_limit).toBe(50);
    expect(o.can_manage).toBe(false);
    expect(o.current).toBeNull();

    await expect(
      scalar(
        seller,
        "select public.admin_save_plan(null, 'seller', 'Pro', null, 4990, null, null, 0, true, 1::smallint)",
      ),
    ).rejects.toThrow(/admin/);
    // Pago custa ao menos R$ 1,00; o gratuito não vira pago nem é desligado.
    await expect(createPlan('seller', 'Barato', 50)).rejects.toThrow(/plans.invalid/);
    const free = o.plan.id;
    await expect(
      scalar(
        admin,
        "select public.admin_save_plan($1, 'seller', 'Grátis', null, 1000, null, null, 0, true, 0::smallint)",
        [free],
      ),
    ).rejects.toThrow(/plans.invalid/);

    const pro = await createPlan('seller', 'Pro', 4990, { ai: 200 });
    await createPlan('supplier', 'Fornecedor Plus', 9990, { featured: 3 });
    expect((await overview(seller, sellerOrg)).plans.map((p) => p.name)).toEqual(['Grátis', 'Pro']);
    expect(
      (
        await db.query(
          "select count(*)::int as n from public.admin_audit_log where action = 'plans.saved'",
        )
      ).rows,
    ).toEqual([{ n: 2 }]);
    // Plano de outro tipo de conta não pode ser assinado.
    await expect(
      scalar(supplier, 'select public.billing_begin_subscription($1, $2)', [supplierOrg, pro]),
    ).rejects.toThrow(/plans.unavailable/);
  });
});

describe('assinatura', () => {
  it('só o proprietário assina; autorização ativa o plano e os limites', async () => {
    const pro = await createPlan('seller', 'Pro', 4990, { ai: 200, maxProducts: 3 });
    await expect(
      scalar(sellerAdmin, 'select public.billing_begin_subscription($1, $2)', [sellerOrg, pro]),
    ).rejects.toThrow(/org.forbidden/);

    const begun = await subscribe(seller, sellerOrg, pro, 'pre1');
    expect(begun.price_cents).toBe(4990);
    // Repetir devolve o mesmo link (não cria outra).
    const again = await scalar<{ subscription_id: string; checkout_url: string }>(
      seller,
      'select public.billing_begin_subscription($1, $2)',
      [sellerOrg, pro],
    );
    expect(again.subscription_id).toBe(begun.subscription_id);
    expect(again.checkout_url).toMatch(/^https:/);
    expect((await overview(seller, sellerOrg)).plan.name).toBe('Grátis');

    // A Edge Function não é chamável pelo navegador.
    await expect(
      scalar(seller, "select public.billing_sync_subscription('{}'::jsonb)"),
    ).rejects.toThrow(/permission denied/);

    expect((await sync('pre1', 'authorized', 4990, '2026-11-02T12:00:00Z')).action).toBe(
      'authorized',
    );
    const o = await overview(seller, sellerOrg);
    expect(o.plan.name).toBe('Pro');
    expect(o.usage.ai_daily_limit).toBe(200);
    expect(o.current).toMatchObject({ status: 'authorized', plan_name: 'Pro' });
    expect(o.pending).toBeNull();
    expect(
      (
        await db.query(
          "select title from public.notifications where user_id = $1 and kind = 'billing.active'",
          [seller],
        )
      ).rows,
    ).toEqual([{ title: 'Plano Pro ativo' }]);
    await expect(
      scalar(seller, 'select public.billing_begin_subscription($1, $2)', [sellerOrg, pro]),
    ).rejects.toThrow(/plans.already_subscribed/);

    // Limite de produtos do plano (arquivados não contam).
    await product(seller, sellerOrg, 'A');
    await product(seller, sellerOrg, 'B');
    const c = await product(seller, sellerOrg, 'C');
    await expect(product(seller, sellerOrg, 'D')).rejects.toThrow(/plans.product_limit/);
    await scalar(seller, "update public.products set status = 'archived' where id = $1", [c]);
    await product(seller, sellerOrg, 'D');
    await expect(
      scalar(seller, "update public.products set status = 'active' where id = $1", [c]),
    ).rejects.toThrow(/plans.product_limit/);
  });

  it('valor divergente cancela; cancelada vale até a próxima cobrança', async () => {
    const pro = await createPlan('seller', 'Pro', 4990);
    await subscribe(seller, sellerOrg, pro, 'pre1');
    expect(await sync('pre1', 'authorized', 100)).toEqual({
      action: 'amount_mismatch',
      cancel: ['pre1'],
    });
    expect((await overview(seller, sellerOrg)).plan.name).toBe('Grátis');

    await subscribe(seller, sellerOrg, pro, 'pre2');
    const next = new Date(Date.now() + 10 * 86_400_000).toISOString();
    await sync('pre2', 'authorized', 4990, next);
    expect(await scalar(seller, 'select public.billing_cancel_begin($1)', [sellerOrg])).toBe(
      'pre2',
    );
    await sync('pre2', 'cancelled', 4990);
    const o = await overview(seller, sellerOrg);
    expect(o.plan.name).toBe('Pro');
    expect(o.current).toMatchObject({ status: 'cancelled' });
    expect(new Date(o.current!.access_until!).toISOString()).toBe(next);
    // Cancelada é final.
    expect(await sync('pre2', 'authorized', 4990)).toEqual({ action: 'ignored', cancel: ['pre2'] });

    // Passou o prazo: volta ao gratuito.
    await db.query(
      "update public.organization_subscriptions set access_until = now() - interval '1 minute'",
    );
    expect((await overview(seller, sellerOrg)).plan.name).toBe('Grátis');
    await expect(
      scalar(seller, 'select public.billing_cancel_begin($1)', [sellerOrg]),
    ).rejects.toThrow(/plans.no_subscription/);
  });

  it('troca de plano cancela a anterior; cobranças ficam no histórico', async () => {
    const pro = await createPlan('seller', 'Pro', 4990);
    const max = await createPlan('seller', 'Max', 9990);
    await subscribe(seller, sellerOrg, pro, 'pre1');
    await sync('pre1', 'authorized', 4990);
    await subscribe(seller, sellerOrg, max, 'pre2');
    expect((await overview(seller, sellerOrg)).pending).toMatchObject({ plan_id: max });
    expect(await sync('pre2', 'authorized', 9990)).toEqual({
      action: 'authorized',
      cancel: ['pre1'],
    });
    expect((await overview(seller, sellerOrg)).plan.name).toBe('Max');

    const pay = (status: string, paymentStatus: string) =>
      service<string>('select public.billing_record_payment($1)', [
        JSON.stringify({
          external_id: '555',
          preapproval_id: 'pre2',
          amount_cents: 9990,
          status,
          payment_status: paymentStatus,
          debit_date: '2026-10-02T12:00:00Z',
        }),
      ]);
    expect(await pay('recycling', 'rejected')).toBe('recorded');
    expect(await pay('recycling', 'rejected')).toBe('recorded');
    expect(await pay('processed', 'approved')).toBe('recorded');
    const o = await overview(seller, sellerOrg);
    expect(o.payments).toEqual([
      expect.objectContaining({ external_id: '555', payment_status: 'approved' }),
    ]);
    // Recusa avisa uma vez só o proprietário.
    expect(
      (
        await db.query(
          "select user_id from public.notifications where kind = 'billing.payment_failed'",
        )
      ).rows,
    ).toEqual([{ user_id: seller }]);
    expect(
      await service('select public.billing_record_payment($1)', [
        JSON.stringify({
          external_id: '9',
          preapproval_id: 'nope',
          amount_cents: 1,
          status: 'processed',
        }),
      ]),
    ).toBe('unknown');
  });
});

describe('destaque no catálogo', () => {
  async function listing(sku: string) {
    const p = await product(supplier, supplierOrg, sku);
    return scalar<string>(
      supplier,
      `insert into public.catalog_listings (organization_id, product_id, wholesale_price_cents, is_published)
       values ($1, $2, 3000, true) returning id`,
      [supplierOrg, p],
    );
  }

  it('vagas do plano, destacados primeiro, e só contam até as vagas', async () => {
    const a = await listing('A');
    const b = await listing('B');
    const c = await listing('C');
    await expect(
      scalar(supplier, 'select public.set_listing_featured($1, true)', [a]),
    ).rejects.toThrow(/plans.featured_limit/);
    await expect(
      scalar(seller, 'select public.set_listing_featured($1, true)', [a]),
    ).rejects.toThrow(/org.forbidden/);

    const plus = await createPlan('supplier', 'Plus', 9990, { featured: 2 });
    await subscribe(supplier, supplierOrg, plus, 'preS');
    await sync('preS', 'authorized', 9990);
    await scalar(supplier, 'select public.set_listing_featured($1, true)', [a]);
    await scalar(supplier, 'select public.set_listing_featured($1, true)', [b]);
    await expect(
      scalar(supplier, 'select public.set_listing_featured($1, true)', [c]),
    ).rejects.toThrow(/plans.featured_limit/);

    const browse = () =>
      asUser(
        db,
        seller,
        async (tx) =>
          (
            await tx.query<{ listing_id: string; featured: boolean }>(
              'select listing_id, featured from public.catalog_browse(null, null, 24, 0)',
            )
          ).rows,
      );
    let list = await browse();
    expect(list.slice(0, 2).every((r) => r.featured)).toBe(true);
    expect(list.find((r) => r.listing_id === c)!.featured).toBe(false);

    // Plano diminui: só o primeiro marcado continua valendo.
    await scalar(
      admin,
      "select public.admin_save_plan($1, 'supplier', 'Plus', null, 9990, null, null, 1, true, 1::smallint)",
      [plus],
    );
    list = await browse();
    expect(list.filter((r) => r.featured).map((r) => r.listing_id)).toEqual([a]);
    expect(await scalar(supplier, 'select public.listing_featured_status($1)', [b])).toEqual({
      marked: true,
      active: false,
      used: 2,
      slots: 1,
    });
    await scalar(supplier, 'select public.set_listing_featured($1, false)', [b]);
    expect((await overview(supplier, supplierOrg)).usage.featured).toBe(1);
  });
});
