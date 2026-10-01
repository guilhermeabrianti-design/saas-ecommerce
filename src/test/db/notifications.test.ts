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
let listing: string;
let supplierItem: string;
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

type Note = { kind: string; title: string; body: string | null; link: string | null };

/** Notificações visíveis para o usuário (pela RLS), mais antigas primeiro. */
const inbox = (user: string, kind?: string) =>
  asUser(
    db,
    user,
    async (tx) =>
      (
        await tx.query<Note>(
          `select kind, title, body, link from public.notifications
         where $1::text is null or kind = $1 order by created_at, title`,
          [kind ?? null],
        )
      ).rows,
  );

const clear = () => db.exec('delete from public.notifications');

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

let nextPaymentId = 9000;

async function paidSale() {
  const created = await service<{ order_id: string; total_cents: number }>(
    'select public.checkout_create_order($1, $2, 1, $3, $4)',
    [imported, importedVariant, JSON.stringify(buyer), crypto.randomUUID()],
  );
  await service('select public.checkout_sync_payment($1)', [
    JSON.stringify({
      external_id: String(nextPaymentId++),
      external_reference: created.order_id,
      status: 'approved',
      status_detail: 'accredited',
      method: 'pix',
      amount_cents: created.total_cents,
      fee_cents: 300,
    }),
  ]);
  return created.order_id;
}

const setStock = (qty: number) =>
  scalar(supplier, 'select public.set_stock($1, $2, null, gen_random_uuid())', [supplierItem, qty]);

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
  supplierItem = await scalar<string>(
    supplier,
    'select id from public.inventory_items where variant_id = $1',
    [sv],
  );
  await scalar(
    supplier,
    "select public.adjust_stock($1, 50, 'purchase', null, gen_random_uuid())",
    [supplierItem],
  );
  listing = await scalar<string>(
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
  await clear();
});

afterEach(async () => {
  await db.close();
});

describe('alertas de estoque', () => {
  it('baixo e esgotado avisam o dono e quem revende; de volta só quem revende', async () => {
    await db.query('update public.inventory_items set min_quantity = 5 where id = $1', [
      supplierItem,
    ]);
    await clear();

    await setStock(10);
    expect(await inbox(supplier)).toEqual([]);

    await setStock(4);
    await setStock(3); // continua baixo: não repete
    expect(await inbox(supplier)).toEqual([
      {
        kind: 'stock.low',
        title: 'Estoque baixo: Camiseta (CAM-AZ)',
        body: 'Disponível agora: 4 · mínimo 5.',
        link: `/estoque/${supplierItem}`,
      },
    ]);
    expect(await inbox(sellerMember, 'stock.low')).toEqual([
      expect.objectContaining({
        title: 'Estoque baixo no fornecedor: Camiseta',
        body: 'Restam 4 no fornecedor (opção CAM-AZ).',
        link: `/produtos/${imported}`,
      }),
    ]);

    await setStock(0);
    expect((await inbox(supplier, 'stock.out')).map((n) => n.title)).toEqual([
      'Esgotado: Camiseta (CAM-AZ)',
    ]);
    expect(await inbox(seller, 'stock.out')).toHaveLength(1);

    await setStock(20);
    expect(await inbox(supplier, 'stock.back')).toEqual([]);
    expect(await inbox(seller, 'stock.back')).toEqual([
      expect.objectContaining({ title: 'De volta ao estoque no fornecedor: Camiseta' }),
    ]);
  });

  it('sem mínimo definido não há alerta de estoque baixo', async () => {
    await setStock(1);
    expect(await inbox(supplier)).toEqual([]);
  });
});

describe('catálogo', () => {
  it('preço de atacado avisa owner/admin de quem revende, em reais', async () => {
    await scalar(
      supplier,
      'update public.catalog_listings set wholesale_price_cents = 250000 where id = $1',
      [listing],
    );
    const expected = [
      {
        kind: 'listing.price',
        title: 'Preço de atacado alterado: Camiseta',
        body: 'De R$ 20,00 para R$ 2.500,00. Confira sua margem e o preço de venda.',
        link: `/produtos/${imported}`,
      },
    ];
    expect(await inbox(seller)).toEqual(expected);
    expect(await inbox(sellerAdmin)).toEqual(expected);
    expect(await inbox(sellerMember)).toEqual([]);
  });

  it('anúncio despublicado, produto desativado e fornecedor suspenso pausam a revenda', async () => {
    await scalar(
      supplier,
      'update public.catalog_listings set is_published = false where id = $1',
      [listing],
    );
    await scalar(supplier, 'update public.catalog_listings set is_published = true where id = $1', [
      listing,
    ]);
    expect((await inbox(sellerMember)).map((n) => n.kind)).toEqual([
      'listing.unavailable',
      'listing.available',
    ]);

    await clear();
    const sourceProduct = await scalar<string>(
      supplier,
      'select product_id from public.catalog_listings where id = $1',
      [listing],
    );
    await scalar(supplier, "update public.products set status = 'archived' where id = $1", [
      sourceProduct,
    ]);
    expect((await inbox(seller)).map((n) => n.kind)).toEqual(['listing.unavailable']);
    await scalar(supplier, "update public.products set status = 'active' where id = $1", [
      sourceProduct,
    ]);

    await clear();
    await scalar(admin, "select public.admin_set_suspension($1, true, 'Documentos')", [
      supplierOrg,
    ]);
    expect((await inbox(seller)).map((n) => n.kind)).toEqual(['listing.unavailable']);
  });

  it('moderação avisa o fornecedor; fornecedor novo não entra mais em fila (Fase 35)', async () => {
    await db.query(
      "update public.catalog_listings set moderation_status = 'rejected' where id = $1",
      [listing],
    );
    expect(await inbox(supplier, 'listing.moderation')).toEqual([
      expect.objectContaining({ title: 'Anúncio recusado: Camiseta' }),
    ]);

    const other = await signUpUser(db, 'novo@example.com', {
      full_name: 'Novo',
      account_type: 'supplier',
    });
    await scalar(other, "select public.create_organization('Fornecedor Novo')");
    expect(await inbox(admin, 'staff.supplier_review')).toEqual([]);
    // Equipe não vê notificações das organizações.
    expect((await inbox(admin)).every((n) => n.kind.startsWith('staff.'))).toBe(true);
  });
});

describe('pedidos, checkout e carteira', () => {
  it('venda paga, pedido ao fornecedor, envio e estorno', async () => {
    const orderId = await paidSale();
    expect(await inbox(seller, 'checkout.paid')).toEqual([
      expect.objectContaining({ body: 'R$ 59,90. O fornecedor já recebeu o pedido de envio.' }),
    ]);
    expect(await inbox(sellerMember, 'checkout.paid')).toEqual([]);
    expect(await inbox(supplier, 'supplier_order.new')).toEqual([
      expect.objectContaining({ body: 'Separe e envie para São Paulo/SP.' }),
    ]);

    const so = await scalar<string>(
      supplier,
      'select id from public.supplier_orders where order_id = $1',
      [orderId],
    );
    await scalar(supplier, "select public.ship_supplier_order($1, 'Correios', 'AA123456789BR')", [
      so,
    ]);
    expect(await inbox(sellerMember, 'order.supplier_shipped')).toEqual([
      expect.objectContaining({ body: 'Correios · AA123456789BR', link: `/pedidos/${orderId}` }),
    ]);
  });

  it('saque: equipe é avisada; organização acompanha a decisão', async () => {
    await db.query(
      `insert into public.withdrawal_requests (organization_id, amount_cents, pix_key_type, pix_key, holder_name, holder_document, request_id)
       values ($1, 1234, 'cpf', '12345678909', 'Vendedor', '12345678909', gen_random_uuid())`,
      [sellerOrg],
    );
    expect(await inbox(admin, 'staff.withdrawal_requested')).toEqual([
      expect.objectContaining({ title: 'Saque solicitado: R$ 12,34', body: 'Loja V' }),
    ]);
    await db.query(
      "update public.withdrawal_requests set status = 'rejected', rejection_reason = 'Chave errada'",
    );
    expect(await inbox(sellerAdmin, 'wallet.withdrawal')).toEqual([
      expect.objectContaining({ title: 'Saque recusado: R$ 12,34', body: 'Motivo: Chave errada' }),
    ]);
    expect(await inbox(sellerMember, 'wallet.withdrawal')).toEqual([]);
  });
});

describe('leitura e privacidade', () => {
  it('cada um lê e marca só as suas; ex-membro deixa de ver; sem escrita direta', async () => {
    await scalar(
      supplier,
      'update public.catalog_listings set is_published = false where id = $1',
      [listing],
    );
    const ids = await asUser(db, seller, async (tx) =>
      (await tx.query<{ id: string }>('select id from public.notifications')).rows.map((r) => r.id),
    );
    expect(ids).toHaveLength(1);

    // Outro usuário não marca a do vendedor.
    expect(await scalar(sellerMember, 'select public.mark_notifications_read($1)', [ids])).toBe(0);
    expect(await scalar(seller, 'select public.mark_notifications_read($1)', [ids])).toBe(1);
    expect(await scalar(sellerMember, 'select public.mark_all_notifications_read(null)')).toBe(1);
    expect(
      await scalar(sellerAdmin, 'select public.mark_all_notifications_read($1)', [supplierOrg]),
    ).toBe(0);

    await expect(scalar(seller, "update public.notifications set title = 'x'")).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      scalar(
        seller,
        "insert into public.notifications (user_id, kind, title) values (auth.uid(), 'x.y', 'Falsa')",
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(scalar(null, 'select count(*) from public.notifications')).rejects.toThrow(
      /permission denied/,
    );

    await scalar(seller, 'select public.remove_member($1, $2)', [sellerOrg, sellerMember]);
    expect(await inbox(sellerMember)).toEqual([]);
  });
});
