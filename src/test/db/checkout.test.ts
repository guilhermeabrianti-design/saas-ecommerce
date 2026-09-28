// @vitest-environment node
import type { PGlite, Transaction } from '@electric-sql/pglite';
import { approveCatalog, asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerMember: string;
let supplier: string;
let admin: string;
let sellerOrg: string;
let supplierOrg: string;
let ownProduct: string;
let imported: string;
let importedVariant: string;
let supplierItem: string;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

/** Como a Edge Function: papel service_role, sem usuário. */
function asService<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec('set local role service_role');
    return fn(tx);
  });
}

async function service<T>(sql: string, params: unknown[] = []): Promise<T> {
  return asService(async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0]!;
}

async function all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
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

type Created = {
  order_id: string;
  order_number: number;
  total_cents: number;
  token: string;
  external_id: string | null;
  status: string;
};

const createCheckout = (
  opts: { quantity?: number; requestId?: string; product?: string; variant?: string | null } = {},
) =>
  service<Created>('select public.checkout_create_order($1, $2, $3, $4, $5)', [
    opts.product ?? imported,
    opts.variant === undefined ? importedVariant : opts.variant,
    opts.quantity ?? 1,
    JSON.stringify(buyer),
    opts.requestId ?? crypto.randomUUID(),
  ]);

let nextPaymentId = 1000;

const sync = (payment: Record<string, unknown>) =>
  service<string>('select public.checkout_sync_payment($1)', [JSON.stringify(payment)]);

function mpPayment(created: Created, overrides: Record<string, unknown> = {}) {
  return {
    external_id: created.external_id ?? String(nextPaymentId++),
    external_reference: created.order_id,
    status: 'approved',
    status_detail: 'accredited',
    method: 'pix',
    amount_cents: created.total_cents,
    fee_cents: 300,
    ...overrides,
  };
}

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  sellerMember = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
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
    "select public.invite_member($1, 'membro@example.com', 'member')",
    [sellerOrg],
  );
  await scalar(sellerMember, 'select public.accept_invitation($1)', [inv]);

  ownProduct = await scalar<string>(
    seller,
    "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, 'PROPRIO', 'Caneca', 3000, 'active') returning id",
    [sellerOrg],
  );

  // Fornecedor: camiseta com uma variação, 5 unidades, atacado R$ 20.
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
  supplierItem = await scalar(
    supplier,
    'select id from public.inventory_items where variant_id = $1',
    [sv],
  );
  await scalar(supplier, "select public.adjust_stock($1, 5, 'purchase', null, gen_random_uuid())", [
    supplierItem,
  ]);
  await db.query(
    `insert into public.product_images (organization_id, product_id, storage_path, position)
     values ($1, $2, $3, 0)`,
    [supplierOrg, sp, `${supplierOrg}/${sp}/foto.jpg`],
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

describe('checkout: vendedor', () => {
  it('só produto importado e ativo entra no checkout; só owner/admin liga', async () => {
    await expect(
      scalar(seller, 'select public.set_product_checkout($1, true)', [ownProduct]),
    ).rejects.toThrow(/checkout.not_eligible/);
    await expect(
      scalar(sellerMember, 'select public.set_product_checkout($1, false)', [imported]),
    ).rejects.toThrow(/checkout.not_found/);
    await expect(
      scalar(supplier, 'select public.set_product_checkout($1, false)', [imported]),
    ).rejects.toThrow(/checkout.not_found/);
    // Coluna não é gravável diretamente.
    await expect(
      scalar(seller, 'update public.products set checkout_enabled = true where id = $1', [
        ownProduct,
      ]),
    ).rejects.toThrow(/permission denied/);
    // Desligar é sempre possível.
    await scalar(seller, 'select public.set_product_checkout($1, false)', [imported]);
  });

  it('resumo mostra a comissão congelável e o motivo de bloqueio', async () => {
    expect(
      await scalar(sellerMember, 'select public.checkout_product_summary($1)', [imported]),
    ).toEqual({
      enabled: true,
      block_reason: null,
      quote: {
        unit_price_cents: 5990,
        quantity: 1,
        sale_cents: 5990,
        supplier_cents: 2000,
        seller_commission_bps: 1500,
        seller_commission_source: 'default',
        seller_commission_cents: 899,
        platform_before_fee_cents: 5990 - 2000 - 899,
      },
    });
    expect(
      await scalar(seller, 'select public.checkout_product_summary($1)', [ownProduct]),
    ).toMatchObject({ enabled: false, block_reason: 'not_imported' });

    await scalar(seller, 'update public.products set price_cents = 2100 where id = $1', [imported]);
    expect(
      await scalar(seller, 'select public.checkout_product_summary($1)', [imported]),
    ).toMatchObject({ block_reason: 'price_below_cost' });

    await expect(
      scalar(supplier, 'select public.checkout_product_summary($1)', [imported]),
    ).rejects.toThrow(/checkout.not_found/);
  });
});

describe('checkout: oferta e pedido', () => {
  it('oferta pública só de produto ligado e visível', async () => {
    const offer = await service<Record<string, unknown>>('select public.checkout_offer($1)', [
      imported,
    ]);
    expect(offer).toMatchObject({
      product_id: imported,
      store_name: 'Loja V',
      price_cents: 5990,
      has_variants: true,
      variants: [
        {
          variant_id: importedVariant,
          attributes: { Cor: 'Azul' },
          price_cents: 5990,
          available: 5,
        },
      ],
    });
    expect(offer.image_paths).toHaveLength(1);

    await scalar(seller, 'select public.set_product_checkout($1, false)', [imported]);
    expect(await service('select public.checkout_offer($1)', [imported])).toBeNull();
    expect(await service('select public.checkout_offer($1)', [ownProduct])).toBeNull();

    // Anúncio bloqueado pela moderação: some do checkout.
    await scalar(seller, 'select public.set_product_checkout($1, true)', [imported]);
    await db.exec("update public.catalog_listings set moderation_status = 'blocked'");
    expect(await service('select public.checkout_offer($1)', [imported])).toBeNull();
  });

  it('comprador e usuários comuns não chamam as funções do servidor', async () => {
    for (const user of [null, seller]) {
      await expect(scalar(user, 'select public.checkout_offer($1)', [imported])).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        scalar(user, 'select public.checkout_create_order($1, $2, 1, $3, gen_random_uuid())', [
          imported,
          importedVariant,
          JSON.stringify(buyer),
        ]),
      ).rejects.toThrow(/permission denied/);
      await expect(scalar(user, "select public.checkout_sync_payment('{}')")).rejects.toThrow(
        /permission denied/,
      );
    }
  });

  it('cria pedido aguardando pagamento, congela a divisão e é idempotente', async () => {
    const requestId = crypto.randomUUID();
    const created = await createCheckout({ quantity: 2, requestId });
    expect(created).toMatchObject({
      order_number: 1,
      total_cents: 11980,
      status: 'pending',
      external_id: null,
    });

    expect(
      await one(
        'select status, channel, created_by, total_cents from public.orders where id = $1',
        [created.order_id],
      ),
    ).toEqual({ status: 'pending', channel: 'checkout', created_by: null, total_cents: 11980 });
    expect(
      await one('select * from public.order_splits where order_id = $1', [created.order_id]),
    ).toMatchObject({
      sale_cents: 11980,
      supplier_cents: 4000,
      seller_commission_bps: 1500,
      seller_commission_source: 'default',
      seller_commission_cents: 1797,
      platform_cents: 11980 - 4000 - 1797,
      payment_fee_cents: null,
    });
    // Nada reservado antes do pagamento.
    expect(
      await one('select reserved from public.inventory_items where id = $1', [supplierItem]),
    ).toEqual({
      reserved: 0,
    });

    const again = await createCheckout({ quantity: 2, requestId });
    expect(again.order_id).toBe(created.order_id);
    expect(again.token).toBe(created.token);
    expect(await one('select count(*)::int as n from public.orders')).toEqual({ n: 1 });
  });

  it('recusa sem estoque, sem variação, desligado ou abaixo do custo', async () => {
    await expect(createCheckout({ quantity: 6 })).rejects.toThrow(/orders.insufficient_stock/);
    await expect(createCheckout({ quantity: 11 })).rejects.toThrow(/checkout.invalid/);
    await expect(createCheckout({ variant: null })).rejects.toThrow(/checkout.invalid/);
    await expect(createCheckout({ product: ownProduct, variant: null })).rejects.toThrow(
      /checkout.unavailable/,
    );
    await scalar(seller, 'update public.products set price_cents = 2100 where id = $1', [imported]);
    await expect(createCheckout()).rejects.toThrow(/checkout.price_below_cost/);
    await scalar(seller, 'select public.set_product_checkout($1, false)', [imported]);
    await expect(createCheckout()).rejects.toThrow(/checkout.unavailable/);
    expect(await one('select count(*)::int as n from public.orders')).toEqual({ n: 0 });
  });

  it('dados do comprador passam pelas mesmas regras do pedido', async () => {
    await expect(
      service('select public.checkout_create_order($1, $2, 1, $3, gen_random_uuid())', [
        imported,
        importedVariant,
        JSON.stringify({ ...buyer, ship_postal_code: '123' }),
      ]),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('checkout: pagamento', () => {
  it('aprovado: confirma, envia ao fornecedor e lança a divisão com a taxa real', async () => {
    const created = await createCheckout();
    const payment = mpPayment(created);
    expect(await sync(payment)).toBe('confirmed');

    expect(
      await one('select status, paid_cents from public.orders where id = $1', [created.order_id]),
    ).toEqual({ status: 'confirmed', paid_cents: 5990 });
    const so = await one<{
      id: string;
      status: string;
      paid_at: string | null;
      total_wholesale_cents: number;
    }>(
      'select id, status, paid_at, total_wholesale_cents from public.supplier_orders where order_id = $1',
      [created.order_id],
    );
    expect(so).toMatchObject({ status: 'pending', total_wholesale_cents: 2000 });
    expect(so.paid_at).not.toBeNull();
    expect(
      await one('select reserved from public.inventory_items where id = $1', [supplierItem]),
    ).toEqual({
      reserved: 1,
    });

    expect(
      await all(
        'select organization_id, kind, amount_cents from public.ledger_entries order by amount_cents',
      ),
    ).toEqual([
      { organization_id: sellerOrg, kind: 'checkout_commission', amount_cents: 899 },
      { organization_id: supplierOrg, kind: 'checkout_supplier', amount_cents: 2000 },
    ]);
    expect(await all('select kind, amount_cents from public.platform_ledger_entries')).toEqual([
      { kind: 'checkout_revenue', amount_cents: 5990 - 300 - 2000 - 899 },
    ]);
    expect(
      await one(
        'select payment_fee_cents, platform_cents, settled_at is not null as settled from public.order_splits',
      ),
    ).toEqual({ payment_fee_cents: 300, platform_cents: 2791, settled: true });
    expect(await one('select kind, method, amount_cents from public.order_payments')).toEqual({
      kind: 'payment',
      method: 'pix',
      amount_cents: 5990,
    });

    // Notificação repetida não lança de novo.
    expect(await sync(payment)).toBe('unchanged');
    expect(await one('select count(*)::int as n from public.ledger_entries')).toEqual({ n: 2 });

    // O vendedor não paga o fornecedor: a plataforma já acertou.
    await expect(scalar(seller, 'select public.pay_supplier_order($1)', [so.id])).rejects.toThrow(
      /finance.already_paid/,
    );
  });

  it('pendente guarda o PIX para o comprador; rejeitado ou expirado cancela', async () => {
    const created = await createCheckout();
    const pending = mpPayment(created, {
      status: 'pending',
      status_detail: 'pending_waiting_transfer',
      pix_qr_code: '00020126...',
      pix_qr_base64: 'iVBORw0KGgo=',
      expires_at: '2026-09-28T13:00:00Z',
    });
    expect(await sync(pending)).toBe('pending');

    const status = await scalar<Record<string, unknown>>(
      null,
      'select public.checkout_order_status($1)',
      [created.token],
    );
    expect(status).toMatchObject({
      order_number: 1,
      store_name: 'Loja V',
      product_name: 'Camiseta',
      total_cents: 5990,
      payment_status: 'pending',
      order_status: 'pending',
      method: 'pix',
      pix_qr_code: '00020126...',
      pix_qr_base64: 'iVBORw0KGgo=',
    });
    expect(await scalar(null, 'select public.checkout_order_status(gen_random_uuid())')).toBeNull();

    expect(await sync({ ...pending, status: 'cancelled', status_detail: 'expired' })).toBe(
      'cancelled',
    );
    expect(await one('select status from public.orders')).toEqual({ status: 'cancelled' });
    // Código do PIX some depois que deixa de valer.
    expect(
      await scalar<Record<string, unknown>>(null, 'select public.checkout_order_status($1)', [
        created.token,
      ]),
    ).toMatchObject({ payment_status: 'cancelled', pix_qr_code: null });

    const card = await createCheckout();
    expect(
      await sync(
        mpPayment(card, {
          status: 'rejected',
          method: 'card',
          status_detail: 'cc_rejected_other_reason',
        }),
      ),
    ).toBe('cancelled');
  });

  it('aprovado sem estoque ou com valor divergente pede estorno e cancela o pedido', async () => {
    const created = await createCheckout();
    // Outro canal vende o estoque do fornecedor antes do pagamento.
    await scalar(supplier, 'select public.set_stock($1, 0, null, gen_random_uuid())', [
      supplierItem,
    ]);
    const payment = mpPayment(created);
    expect(await sync(payment)).toBe('refund_required');
    expect(await one('select status from public.orders')).toEqual({ status: 'cancelled' });
    expect(await one('select needs_refund, refund_reason from public.checkout_payments')).toEqual({
      needs_refund: true,
      refund_reason: 'orders.insufficient_stock',
    });
    expect(await one('select count(*)::int as n from public.supplier_orders')).toEqual({ n: 0 });
    expect(await one('select count(*)::int as n from public.ledger_entries')).toEqual({ n: 0 });
    // Nova notificação de aprovado continua pedindo o estorno.
    expect(await sync(payment)).toBe('refund_required');
    // Estorno feito: pendência resolvida, nada a desfazer no livro-razão.
    expect(await sync({ ...payment, status: 'refunded' })).toBe('unchanged');
    expect(await one('select needs_refund, status from public.checkout_payments')).toEqual({
      needs_refund: false,
      status: 'refunded',
    });

    await scalar(supplier, 'select public.set_stock($1, 5, null, gen_random_uuid())', [
      supplierItem,
    ]);
    const second = await createCheckout();
    expect(await sync(mpPayment(second, { amount_cents: 100 }))).toBe('refund_required');
    expect(
      await one('select refund_reason from public.checkout_payments where order_id = $1', [
        second.order_id,
      ]),
    ).toEqual({ refund_reason: 'amount_mismatch' });
  });

  it('estorno antes do envio: cancela, libera reservas e desfaz a divisão', async () => {
    const created = await createCheckout();
    const payment = mpPayment(created);
    await sync(payment);
    expect(await sync({ ...payment, status: 'refunded' })).toBe('reversed');

    expect(await one('select status, paid_cents, refunded_cents from public.orders')).toEqual({
      status: 'cancelled',
      paid_cents: 5990,
      refunded_cents: 5990,
    });
    expect(
      await one('select reserved from public.inventory_items where id = $1', [supplierItem]),
    ).toEqual({
      reserved: 0,
    });
    const sums = await all<{ organization_id: string; total: number }>(
      'select organization_id, sum(amount_cents)::int as total from public.ledger_entries group by 1',
    );
    expect(sums.every((s) => s.total === 0)).toBe(true);
    expect(
      await one('select sum(amount_cents)::int as total from public.platform_ledger_entries'),
    ).toEqual({
      total: 0,
    });
    expect(await sync({ ...payment, status: 'refunded' })).toBe('unchanged');
  });

  it('contestação depois do envio: fornecedor fica com o atacado, plataforma absorve', async () => {
    const created = await createCheckout();
    const payment = mpPayment(created);
    await sync(payment);
    const soId = (await one<{ id: string }>('select id from public.supplier_orders')).id;
    await scalar(supplier, "select public.ship_supplier_order($1, 'Correios', 'AA123456789BR')", [
      soId,
    ]);

    expect(await sync({ ...payment, status: 'charged_back' })).toBe('reversed');
    expect(await one('select status from public.orders')).toEqual({ status: 'confirmed' });
    expect(
      await all(
        'select organization_id, sum(amount_cents)::int as total from public.ledger_entries group by 1 order by 2',
      ),
    ).toEqual([
      { organization_id: sellerOrg, total: 0 },
      { organization_id: supplierOrg, total: 2000 },
    ]);
    expect(
      await one('select sum(amount_cents)::int as total from public.platform_ledger_entries'),
    ).toEqual({
      total: -2000,
    });

    // O comprador vê o rastreio.
    expect(
      await scalar<Record<string, unknown>>(null, 'select public.checkout_order_status($1)', [
        created.token,
      ]),
    ).toMatchObject({ tracking: [{ carrier: 'Correios', code: 'AA123456789BR' }] });
  });

  it('tentativa sem pagamento é cancelada (recusa imediata ou abandono de 1 hora)', async () => {
    const refused = await createCheckout();
    await service('select public.checkout_abandon($1)', [refused.order_id]);
    expect(await one('select status from public.orders where id = $1', [refused.order_id])).toEqual(
      {
        status: 'cancelled',
      },
    );

    const stale = await createCheckout();
    await db.query(
      "update public.orders set created_at = now() - interval '2 hours' where id = $1",
      [stale.order_id],
    );
    // Com pagamento criado não expira por aqui (o Mercado Pago avisa o vencimento).
    const withPayment = await createCheckout();
    await sync(mpPayment(withPayment, { status: 'pending' }));
    await db.query(
      "update public.orders set created_at = now() - interval '2 hours' where id = $1",
      [withPayment.order_id],
    );
    await createCheckout();
    expect(await one('select status from public.orders where id = $1', [stale.order_id])).toEqual({
      status: 'cancelled',
    });
    expect(
      await one('select status from public.orders where id = $1', [withPayment.order_id]),
    ).toEqual({
      status: 'pending',
    });
    // Pagamento já vinculado: abandonar não cancela.
    await service('select public.checkout_abandon($1)', [withPayment.order_id]);
    expect(
      await one('select status from public.orders where id = $1', [withPayment.order_id]),
    ).toEqual({
      status: 'pending',
    });
  });

  it('pagamento desconhecido é recusado (o Mercado Pago tenta de novo)', async () => {
    await expect(
      sync({
        external_id: '999',
        external_reference: crypto.randomUUID(),
        status: 'approved',
        amount_cents: 10,
      }),
    ).rejects.toThrow(/checkout.payment_not_found/);
    await expect(
      sync({ external_id: 'abc', status: 'approved', amount_cents: 10 }),
    ).rejects.toThrow(/checkout.invalid/);
  });
});

describe('checkout: ações manuais e leitura', () => {
  it('vendedor não confirma, cancela nem registra pagamento de pedido do checkout', async () => {
    const created = await createCheckout();
    for (const fn of ['confirm_order', 'cancel_order']) {
      await expect(scalar(seller, `select public.${fn}($1)`, [created.order_id])).rejects.toThrow(
        /orders.checkout_managed/,
      );
    }
    await expect(
      scalar(
        seller,
        "select public.record_order_payment($1, 100, 'pix', null, gen_random_uuid())",
        [created.order_id],
      ),
    ).rejects.toThrow(/orders.checkout_managed/);
    await expect(
      scalar(
        seller,
        "select public.refund_order_payment($1, 100, 'pix', null, gen_random_uuid())",
        [created.order_id],
      ),
    ).rejects.toThrow(/orders.checkout_managed/);
  });

  it('owner/admin do vendedor leem pagamento e divisão; membro e fornecedor não', async () => {
    const created = await createCheckout();
    await sync(mpPayment(created, { status: 'pending', pix_qr_code: 'x' }));
    const read = (user: string) =>
      asUser(db, user, async (tx) => ({
        pay: (await tx.query('select status, method from public.checkout_payments')).rows,
        split: (await tx.query('select seller_commission_cents from public.order_splits')).rows,
      }));
    expect(await read(seller)).toEqual({
      pay: [{ status: 'pending', method: 'pix' }],
      split: [{ seller_commission_cents: 899 }],
    });
    expect(await read(sellerMember)).toEqual({ pay: [], split: [] });
    expect(await read(supplier)).toEqual({ pay: [], split: [] });
    // Token e código do PIX não são lidos pela tabela.
    await expect(
      scalar(seller, 'select public_token from public.checkout_payments'),
    ).rejects.toThrow(/permission denied/);
    await expect(
      scalar(seller, 'select count(*) from public.platform_ledger_entries'),
    ).rejects.toThrow(/permission denied/);
  });

  it('livro-razão da plataforma é imutável', async () => {
    const created = await createCheckout();
    await sync(mpPayment(created));
    await expect(
      db.exec('update public.platform_ledger_entries set amount_cents = 1'),
    ).rejects.toThrow(/finance.ledger_immutable/);
    await expect(db.exec('delete from public.platform_ledger_entries')).rejects.toThrow(
      /finance.ledger_immutable/,
    );
  });
});

describe('checkout: equipe', () => {
  it('resumo, lista e início do estorno auditado', async () => {
    const created = await createCheckout();
    const payment = mpPayment(created);
    await sync(payment);

    await expect(scalar(seller, 'select public.admin_checkout_summary()')).rejects.toThrow(
      /admin.forbidden/,
    );
    expect(await scalar(admin, 'select public.admin_checkout_summary()')).toEqual({
      approved_cents: 5990,
      fees_cents: 300,
      supplier_cents: 2000,
      commission_cents: 899,
      platform_cents: 2791,
      needs_refund: 0,
    });
    const list = await asUser(
      db,
      admin,
      async (tx) =>
        (
          await tx.query(
            "select order_number, store_name, refundable from public.admin_checkout_payments('all', 50, 0)",
          )
        ).rows,
    );
    expect(list).toEqual([{ order_number: 1, store_name: 'Loja V', refundable: true }]);

    await expect(
      scalar(seller, 'select public.admin_checkout_refund_begin($1)', [created.order_id]),
    ).rejects.toThrow(/admin.forbidden/);
    expect(
      await scalar(admin, 'select public.admin_checkout_refund_begin($1)', [created.order_id]),
    ).toBe(payment.external_id);
    expect(
      await one("select action, details->>'amount_cents' as amount from public.admin_audit_log"),
    ).toEqual({
      action: 'checkout.refund',
      amount: '5990',
    });

    const soId = (await one<{ id: string }>('select id from public.supplier_orders')).id;
    await scalar(supplier, "select public.ship_supplier_order($1, 'Correios', 'AA123456789BR')", [
      soId,
    ]);
    await expect(
      scalar(admin, 'select public.admin_checkout_refund_begin($1)', [created.order_id]),
    ).rejects.toThrow(/checkout.already_shipped/);

    const pending = await createCheckout();
    await expect(
      scalar(admin, 'select public.admin_checkout_refund_begin($1)', [pending.order_id]),
    ).rejects.toThrow(/checkout.not_found/);
  });
});
