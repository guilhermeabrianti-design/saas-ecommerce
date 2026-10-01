// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { approveCatalog, asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerMember: string;
let supplier: string;
let otherSeller: string;
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

let nextPaymentId = 11000;

/** Venda paga pelo checkout: devolve pedido, token e pedido de fornecimento. */
async function paidSale() {
  const created = await service<{ order_id: string; total_cents: number; token: string }>(
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
  const so = await scalar<string>(
    supplier,
    'select id from public.supplier_orders where order_id = $1',
    [created.order_id],
  );
  return { orderId: created.order_id, token: created.token, supplierOrderId: so, payment };
}

const ship = (supplierOrderId: string) =>
  scalar(supplier, "select public.ship_supplier_order($1, 'Correios', 'AA123456789BR')", [
    supplierOrderId,
  ]);

const status = (token: string) =>
  asUser(
    db,
    null,
    async (tx) =>
      (
        await tx.query<{ s: { can_review: boolean; review: unknown } }>(
          'select public.checkout_order_status($1) as s',
          [token],
        )
      ).rows[0]!.s,
  );

const review = (token: string, rating: number, comment: string | null = null) =>
  service('select public.checkout_submit_review($1, $2, $3)', [token, rating, comment]);

type Reputation = {
  rating_avg: number | null;
  rating_count: number;
  distribution: Record<string, number>;
  metrics: Record<string, number | null>;
  can_reply: boolean;
  reviews: {
    id: string;
    reviewer_label: string;
    rating: number;
    comment: string | null;
    reply: string | null;
  }[];
};

const reputation = (user: string, org: string) =>
  scalar<Reputation>(user, 'select public.organization_reputation($1, 20, 0)', [org]);

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  sellerMember = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
  otherSeller = await signUpUser(db, 'outra@example.com', { full_name: 'Outra' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Forn',
    account_type: 'supplier',
  });
  admin = await signUpUser(db, 'staff@example.com', { full_name: 'Equipe' });
  await db.query("update public.profiles set role = 'admin' where id = $1", [admin]);

  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  await scalar(otherSeller, "select public.create_organization('Loja W')");
  supplierOrg = await scalar(supplier, "select public.create_organization('Fábrica X')");
  const inv = await scalar<string>(
    seller,
    "select public.invite_member($1, 'membro@example.com', 'member')",
    [sellerOrg],
  );
  await scalar(sellerMember, 'select public.accept_invitation($1)', [inv]);

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
  const item = await scalar<string>(
    supplier,
    'select id from public.inventory_items where variant_id = $1',
    [sv],
  );
  await scalar(
    supplier,
    "select public.adjust_stock($1, 50, 'purchase', null, gen_random_uuid())",
    [item],
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

describe('avaliação do comprador', () => {
  it('só depois do envio, uma vez, com primeiro nome; entra na reputação da loja', async () => {
    const sale = await paidSale();
    expect((await status(sale.token)).can_review).toBe(false);
    await expect(review(sale.token, 5)).rejects.toThrow(/reviews.not_allowed/);

    await ship(sale.supplierOrderId);
    expect((await status(sale.token)).can_review).toBe(true);
    await expect(review(sale.token, 6)).rejects.toThrow(/reviews.invalid/);
    await review(sale.token, 4, '  Chegou rápido.  ');
    await expect(review(sale.token, 5)).rejects.toThrow(/reviews.already_reviewed/);
    expect(await status(sale.token)).toMatchObject({
      can_review: false,
      review: { rating: 4, comment: 'Chegou rápido.', reply: null },
    });

    const rep = await reputation(seller, sellerOrg);
    expect(rep).toMatchObject({ rating_avg: 4, rating_count: 1, can_reply: true });
    expect(rep.distribution).toMatchObject({ '4': 1, '5': 0 });
    expect(rep.reviews[0]).toMatchObject({ reviewer_label: 'Maria', rating: 4 });
    // Nada de e-mail ou documento na avaliação.
    expect(JSON.stringify(rep)).not.toMatch(/maria@example.com|12345678909/);

    expect(await service('select public.store_rating($1, null)', [imported])).toEqual({
      rating_avg: 4,
      rating_count: 1,
    });
  });

  it('venda estornada não é avaliada; anon não chama a RPC de envio', async () => {
    const sale = await paidSale();
    await service('select public.checkout_sync_payment($1)', [
      JSON.stringify({ ...sale.payment, status: 'refunded' }),
    ]);
    await expect(review(sale.token, 1)).rejects.toThrow(/reviews.not_allowed/);
    await expect(
      scalar(null, 'select public.checkout_submit_review($1, 5, null)', [sale.token]),
    ).rejects.toThrow(/permission denied/);
    await expect(review(crypto.randomUUID(), 5)).rejects.toThrow(/reviews.not_found/);
  });
});

describe('vendedor avalia fornecedor', () => {
  it('por fornecimento enviado, owner/admin, uma vez; métricas do fornecedor', async () => {
    const sale = await paidSale();
    await expect(
      scalar(seller, 'select public.review_supplier_order($1, 5, null)', [sale.supplierOrderId]),
    ).rejects.toThrow(/reviews.not_allowed/);
    await ship(sale.supplierOrderId);
    await expect(
      scalar(sellerMember, 'select public.review_supplier_order($1, 5, null)', [
        sale.supplierOrderId,
      ]),
    ).rejects.toThrow(/reviews.not_found/);
    await scalar(seller, "select public.review_supplier_order($1, 2, 'Embalagem ruim')", [
      sale.supplierOrderId,
    ]);
    await expect(
      scalar(seller, 'select public.review_supplier_order($1, 5, null)', [sale.supplierOrderId]),
    ).rejects.toThrow(/reviews.already_reviewed/);
    expect(
      await asUser(
        db,
        seller,
        async (tx) =>
          (
            await tx.query('select rating, comment from public.my_supplier_reviews($1)', [
              sale.orderId,
            ])
          ).rows,
      ),
    ).toEqual([{ rating: 2, comment: 'Embalagem ruim' }]);

    // Outro vendedor (escolhendo no catálogo) vê a reputação do fornecedor, sem saber quem avaliou.
    const rep = await reputation(otherSeller, supplierOrg);
    expect(rep).toMatchObject({ rating_avg: 2, rating_count: 1, can_reply: false });
    expect(rep.reviews[0]).toMatchObject({ reviewer_label: 'Vendedor verificado' });
    expect(rep.metrics).toMatchObject({ orders: 1, shipped: 1, cancelled: 0 });

    // Pelo anúncio do catálogo também.
    const listingId = (await db.query<{ id: string }>('select id from public.catalog_listings'))
      .rows[0]!.id;
    expect(
      await scalar(otherSeller, 'select public.listing_supplier_reputation($1)', [listingId]),
    ).toMatchObject({ name: expect.stringMatching(/^Fornecedor [0-9A-F]{6}$/), rating_count: 1 });

    // Loja de outro vendedor não é pública para contas conectadas.
    await expect(reputation(otherSeller, sellerOrg)).rejects.toThrow(/reviews.not_found/);
  });
});

describe('resposta e moderação', () => {
  it('avaliado responde uma vez; equipe oculta com motivo (fora da média) e fica auditado', async () => {
    const sale = await paidSale();
    await ship(sale.supplierOrderId);
    await review(sale.token, 1, 'Horrível');
    const id = (await reputation(seller, sellerOrg)).reviews[0]!.id;

    await expect(
      scalar(sellerMember, "select public.reply_review($1, 'Oi')", [id]),
    ).rejects.toThrow(/reviews.not_found/);
    await scalar(seller, "select public.reply_review($1, 'Vamos resolver.')", [id]);
    await expect(scalar(seller, "select public.reply_review($1, 'De novo')", [id])).rejects.toThrow(
      /reviews.already_replied/,
    );

    await expect(
      scalar(admin, 'select public.admin_set_review_hidden($1, true, null)', [id]),
    ).rejects.toThrow(/reviews.reason_required/);
    await scalar(admin, "select public.admin_set_review_hidden($1, true, 'Ofensivo')", [id]);
    expect(await reputation(seller, sellerOrg)).toMatchObject({ rating_count: 0, reviews: [] });
    expect(
      await scalar(admin, "select count(*)::int from public.admin_reviews('hidden', 50, 0)"),
    ).toBe(1);
    expect(
      (await db.query("select action from public.admin_audit_log where action = 'review.hide'"))
        .rows,
    ).toHaveLength(1);
    await expect(
      scalar(seller, 'select public.admin_set_review_hidden($1, false, null)', [id]),
    ).rejects.toThrow(/admin.forbidden/);
    await expect(scalar(seller, 'select count(*) from public.reviews')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('avisa a organização avaliada', async () => {
    const sale = await paidSale();
    await ship(sale.supplierOrderId);
    await review(sale.token, 5);
    expect(
      await scalar(
        seller,
        "select count(*)::int from public.notifications where kind = 'review.new'",
      ),
    ).toBe(1);
  });
});
