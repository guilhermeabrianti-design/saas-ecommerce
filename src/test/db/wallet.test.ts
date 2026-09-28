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

let nextPaymentId = 5000;

/** Venda aprovada pelo checkout: comissão 899 (vendedor) e atacado 2000 (fornecedor). */
async function approvedSale() {
  const created = await service<{ order_id: string; total_cents: number }>(
    'select public.checkout_create_order($1, $2, 1, $3, $4)',
    [imported, importedVariant, JSON.stringify(buyer), crypto.randomUUID()],
  );
  const payment = {
    external_id: String(nextPaymentId++),
    external_reference: created.order_id,
    status: 'approved',
    status_detail: 'accredited',
    method: 'pix',
    amount_cents: created.total_cents,
    fee_cents: 300,
  };
  await service('select public.checkout_sync_payment($1)', [JSON.stringify(payment)]);
  const so = await one<{ id: string }>(
    'select id from public.supplier_orders where order_id = $1',
    [created.order_id],
  );
  return { orderId: created.order_id, supplierOrderId: so.id, payment };
}

/** Envio do fornecedor, envio e entrega do vendedor. */
async function shipAndDeliver(sale: { orderId: string; supplierOrderId: string }) {
  await scalar(supplier, "select public.ship_supplier_order($1, 'Correios', 'AA123456789BR')", [
    sale.supplierOrderId,
  ]);
  await scalar(seller, 'select public.ship_order($1)', [sale.orderId]);
  await scalar(seller, 'select public.deliver_order($1)', [sale.orderId]);
}

/** Leva a entrega/envio do pedido `days` dias para o passado. */
async function ageOrder(orderId: string, days: number) {
  await db.query(
    `update public.orders set delivered_at = delivered_at - make_interval(days => $2) where id = $1`,
    [orderId, days],
  );
  await db.query(
    `update public.supplier_orders set shipped_at = shipped_at - make_interval(days => $2) where order_id = $1`,
    [orderId, days],
  );
}

type Summary = {
  available_cents: number;
  pending_cents: number;
  blocked_cents: number;
  withdrawn_cents: number;
  can_withdraw: boolean;
};

const summary = (user: string, org: string) =>
  scalar<Summary>(user, 'select public.wallet_summary($1)', [org]);

const pix = { type: 'cpf', key: '123.456.789-09', name: 'Vendedor da Silva', doc: '12345678909' };

const requestWithdrawal = (
  amount: number,
  opts: { user?: string; org?: string; requestId?: string; key?: string; type?: string } = {},
) =>
  scalar<string>(
    opts.user ?? seller,
    'select public.request_withdrawal($1, $2, $3, $4, $5, $6, $7)',
    [
      opts.org ?? sellerOrg,
      amount,
      opts.type ?? pix.type,
      opts.key ?? pix.key,
      pix.name,
      pix.doc,
      opts.requestId ?? crypto.randomUUID(),
    ],
  );

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

describe('carteira: saldos', () => {
  it('crédito do checkout fica pendente até o prazo e depois disponível', async () => {
    const sale = await approvedSale();
    expect(await summary(seller, sellerOrg)).toMatchObject({
      available_cents: 0,
      pending_cents: 899,
      blocked_cents: 0,
      can_withdraw: true,
    });
    expect(await summary(supplier, supplierOrg)).toMatchObject({ pending_cents: 2000 });

    // Entregue há menos de 7 dias: ainda pendente.
    await shipAndDeliver(sale);
    await ageOrder(sale.orderId, 6);
    expect(await summary(seller, sellerOrg)).toMatchObject({
      available_cents: 0,
      pending_cents: 899,
    });
    const pending = await scalar<unknown[]>(
      seller,
      'select json_agg(p) from public.wallet_pending($1) p',
      [sellerOrg],
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ order_id: sale.orderId, amount_cents: 899 });

    await ageOrder(sale.orderId, 2);
    expect(await summary(seller, sellerOrg)).toMatchObject({
      available_cents: 899,
      pending_cents: 0,
    });
    expect(await summary(supplier, supplierOrg)).toMatchObject({ available_cents: 2000 });
    expect(
      await scalar(seller, 'select count(*)::int from public.wallet_pending($1)', [sellerOrg]),
    ).toBe(0);
  });

  it('sem entrega marcada, libera pelo prazo após o envio do fornecedor', async () => {
    const sale = await approvedSale();
    await scalar(supplier, "select public.ship_supplier_order($1, 'Correios', 'AA123456789BR')", [
      sale.supplierOrderId,
    ]);
    await ageOrder(sale.orderId, 29);
    expect(await summary(supplier, supplierOrg)).toMatchObject({ pending_cents: 2000 });
    await ageOrder(sale.orderId, 1);
    expect(await summary(supplier, supplierOrg)).toMatchObject({
      available_cents: 2000,
      pending_cents: 0,
    });
  });

  it('estorno antes da liberação se compensa; lançamentos manuais ficam fora', async () => {
    const sale = await approvedSale();
    await service('select public.checkout_sync_payment($1)', [
      JSON.stringify({ ...sale.payment, status: 'refunded' }),
    ]);
    expect(await summary(seller, sellerOrg)).toMatchObject({
      available_cents: 0,
      pending_cents: 0,
    });

    // Recebimento manual (Fase 9) não passa pela plataforma.
    const orderId = await scalar<string>(
      seller,
      `select public.create_order($1, $2, gen_random_uuid())`,
      [
        sellerOrg,
        JSON.stringify({
          ...buyer,
          items: [
            {
              inventory_item_id: await scalar(
                seller,
                'select id from public.inventory_items where variant_id = $1',
                [importedVariant],
              ),
              quantity: 1,
            },
          ],
        }),
      ],
    );
    await scalar(
      seller,
      "select public.record_order_payment($1, 1000, 'pix', null, gen_random_uuid())",
      [orderId],
    );
    expect(await summary(seller, sellerOrg)).toMatchObject({
      available_cents: 0,
      pending_cents: 0,
    });
  });

  it('só owner/admin veem a carteira; só o owner pode sacar', async () => {
    expect(await summary(sellerAdmin, sellerOrg)).toMatchObject({ can_withdraw: false });
    await expect(summary(sellerMember, sellerOrg)).rejects.toThrow(/org.forbidden/);
    await expect(summary(supplier, sellerOrg)).rejects.toThrow(/org.forbidden/);
    await expect(
      scalar(sellerMember, 'select count(*) from public.wallet_pending($1)', [sellerOrg]),
    ).rejects.toThrow(/org.forbidden/);
  });
});

describe('carteira: saques', () => {
  let sale: Awaited<ReturnType<typeof approvedSale>>;

  beforeEach(async () => {
    sale = await approvedSale();
    await shipAndDeliver(sale);
    await ageOrder(sale.orderId, 8);
    // Mínimo baixo para os valores de teste (padrão: R$ 10,00).
    await scalar(admin, 'select public.admin_save_wallet_settings(7, 30, 100)');
  });

  it('solicita, bloqueia o valor e é idempotente', async () => {
    const requestId = crypto.randomUUID();
    const id = await requestWithdrawal(500, { requestId });
    expect(await requestWithdrawal(500, { requestId })).toBe(id);
    expect(await summary(seller, sellerOrg)).toMatchObject({
      available_cents: 399,
      blocked_cents: 500,
    });
    // Chave normalizada.
    expect(
      await one('select pix_key, status from public.withdrawal_requests where id = $1', [id]),
    ).toEqual({ pix_key: '12345678909', status: 'requested' });

    // O que sobra não cobre outro saque.
    await expect(requestWithdrawal(400)).rejects.toThrow(/wallet.insufficient/);
  });

  it('recusa valor mínimo, chave inválida, titular inválido e quem não é owner', async () => {
    await expect(requestWithdrawal(99)).rejects.toThrow(/wallet.below_minimum/);
    await expect(requestWithdrawal(1000)).rejects.toThrow(/wallet.insufficient/);
    await expect(requestWithdrawal(500, { key: '11111111111' })).rejects.toThrow(
      /wallet.invalid_pix_key/,
    );
    await expect(requestWithdrawal(500, { type: 'email', key: 'sem-arroba' })).rejects.toThrow(
      /wallet.invalid_pix_key/,
    );
    await expect(
      scalar(
        seller,
        'select public.request_withdrawal($1, 500, $2, $3, $4, $5, gen_random_uuid())',
        [sellerOrg, 'email', ' Loja@Example.com ', 'Vendedor', '00000000000'],
      ),
    ).rejects.toThrow(/wallet.invalid_holder/);
    await expect(requestWithdrawal(500, { user: sellerAdmin })).rejects.toThrow(/wallet.forbidden/);
    await expect(requestWithdrawal(500, { user: supplier })).rejects.toThrow(/wallet.forbidden/);

    const id = await requestWithdrawal(500, { type: 'email', key: ' Loja@Example.com ' });
    expect(await one('select pix_key from public.withdrawal_requests where id = $1', [id])).toEqual(
      {
        pix_key: 'loja@example.com',
      },
    );
  });

  it('o owner cancela enquanto solicitado; tabela não é gravável diretamente', async () => {
    const id = await requestWithdrawal(500);
    await expect(scalar(sellerAdmin, 'select public.cancel_withdrawal($1)', [id])).rejects.toThrow(
      /wallet.not_found/,
    );
    await scalar(seller, 'select public.cancel_withdrawal($1)', [id]);
    expect(await summary(seller, sellerOrg)).toMatchObject({
      available_cents: 899,
      blocked_cents: 0,
    });
    await expect(scalar(seller, 'select public.cancel_withdrawal($1)', [id])).rejects.toThrow(
      /wallet.invalid_status/,
    );

    await expect(
      scalar(seller, "update public.withdrawal_requests set status = 'paid' where id = $1", [id]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      scalar(seller, 'update public.wallet_settings set min_withdrawal_cents = 100'),
    ).rejects.toThrow(/permission denied/);

    // Leitura: owner/admin sim, membro não.
    expect(await scalar(sellerAdmin, 'select count(*)::int from public.withdrawal_requests')).toBe(
      1,
    );
    expect(await scalar(sellerMember, 'select count(*)::int from public.withdrawal_requests')).toBe(
      0,
    );
  });

  it('equipe aprova, paga (débito no razão) e tudo fica auditado', async () => {
    const id = await requestWithdrawal(800);
    await expect(
      scalar(seller, 'select public.admin_approve_withdrawal($1)', [id]),
    ).rejects.toThrow(/admin.forbidden/);
    await expect(
      scalar(admin, "select public.admin_pay_withdrawal($1, 'E2E123')", [id]),
    ).rejects.toThrow(/wallet.invalid_status/);

    const listed = await scalar<{ amount_cents: number; available_cents: number }[]>(
      admin,
      "select json_agg(w) from public.admin_withdrawals('open', 50, 0) w",
    );
    expect(listed).toMatchObject([
      { amount_cents: 800, available_cents: 99, organization_name: 'Loja V' },
    ]);
    expect(await scalar(admin, 'select public.admin_withdrawals_overview()')).toMatchObject({
      requested_count: 1,
      requested_cents: 800,
    });

    await scalar(admin, 'select public.admin_approve_withdrawal($1)', [id]);
    // Aprovado não pode mais ser cancelado pelo vendedor.
    await expect(scalar(seller, 'select public.cancel_withdrawal($1)', [id])).rejects.toThrow(
      /wallet.invalid_status/,
    );
    await expect(
      scalar(admin, "select public.admin_pay_withdrawal($1, ' ')", [id]),
    ).rejects.toThrow(/wallet.reference_required/);
    await scalar(admin, "select public.admin_pay_withdrawal($1, 'E2E123456')", [id]);

    expect(await summary(seller, sellerOrg)).toMatchObject({
      available_cents: 99,
      blocked_cents: 0,
      withdrawn_cents: 800,
    });
    expect(
      await one(
        "select amount_cents, request_id from public.ledger_entries where kind = 'withdrawal'",
      ),
    ).toEqual({ amount_cents: -800, request_id: id });
    await expect(
      scalar(admin, "select public.admin_pay_withdrawal($1, 'E2E123456')", [id]),
    ).rejects.toThrow(/wallet.invalid_status/);

    expect(
      (
        await db.query<{ action: string }>(
          "select action from public.admin_audit_log where action like 'wallet.%' order by created_at",
        )
      ).rows.map((r) => r.action),
    ).toEqual(['wallet.settings', 'wallet.approve', 'wallet.pay']);
  });

  it('recusa exige motivo e devolve o valor ao disponível', async () => {
    const id = await requestWithdrawal(800);
    await expect(
      scalar(admin, "select public.admin_reject_withdrawal($1, 'x')", [id]),
    ).rejects.toThrow(/wallet.reason_required/);
    await scalar(admin, "select public.admin_reject_withdrawal($1, 'Chave PIX de outro titular')", [
      id,
    ]);
    expect(await summary(seller, sellerOrg)).toMatchObject({
      available_cents: 899,
      blocked_cents: 0,
    });
    expect(
      await one('select status, rejection_reason from public.withdrawal_requests where id = $1', [
        id,
      ]),
    ).toEqual({ status: 'rejected', rejection_reason: 'Chave PIX de outro titular' });
  });

  it('contestação depois da liberação reduz o disponível e impede a aprovação', async () => {
    const id = await requestWithdrawal(800);
    await service('select public.checkout_sync_payment($1)', [
      JSON.stringify({ ...sale.payment, status: 'charged_back' }),
    ]);
    expect(await summary(seller, sellerOrg)).toMatchObject({
      available_cents: -800,
      blocked_cents: 800,
    });
    await expect(scalar(admin, 'select public.admin_approve_withdrawal($1)', [id])).rejects.toThrow(
      /wallet.insufficient/,
    );
    // O fornecedor já enviou: fica com o atacado.
    expect(await summary(supplier, supplierOrg)).toMatchObject({ available_cents: 2000 });
  });

  it('organização suspensa não saca nem tem saque aprovado', async () => {
    const id = await requestWithdrawal(800);
    await scalar(admin, "select public.admin_set_suspension($1, true, 'Fraude em análise')", [
      sellerOrg,
    ]);
    await expect(scalar(admin, 'select public.admin_approve_withdrawal($1)', [id])).rejects.toThrow(
      /wallet.organization_suspended/,
    );
    await expect(requestWithdrawal(50)).rejects.toThrow(/wallet.forbidden/);
  });

  it('só a equipe altera as regras, dentro dos limites', async () => {
    await expect(
      scalar(seller, 'select public.admin_save_wallet_settings(0, 1, 100)'),
    ).rejects.toThrow(/admin.forbidden/);
    await expect(
      scalar(admin, 'select public.admin_save_wallet_settings(-1, 30, 1000)'),
    ).rejects.toThrow(/check constraint/);
    await scalar(admin, 'select public.admin_save_wallet_settings(14, 30, 100)');
    expect(await summary(seller, sellerOrg)).toMatchObject({
      available_cents: 0,
      pending_cents: 899,
    });
    expect(await one('select release_days_after_delivery from public.wallet_settings')).toEqual({
      release_days_after_delivery: 14,
    });
  });
});
