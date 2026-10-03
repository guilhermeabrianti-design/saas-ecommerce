// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let seller2: string;
let supplier: string;
let supplierMember: string;
let admin: string;
let sellerOrg: string;
let supplierOrg: string;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

async function rows<T>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, userId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

async function service<T>(sql: string, params: unknown[] = []): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec('set local role service_role');
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

async function listing(sku: string) {
  const p = await scalar<string>(
    supplier,
    "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, $2, $3, 5000, 'active') returning id",
    [supplierOrg, sku, `Produto ${sku}`],
  );
  return scalar<string>(
    supplier,
    `insert into public.catalog_listings (organization_id, product_id, wholesale_price_cents, is_published)
     values ($1, $2, 3000, true) returning id`,
    [supplierOrg, p],
  );
}

const savePackage = (
  placement: 'catalog' | 'sales_center',
  price: number,
  maxActive: number | null = null,
  days = 7,
) =>
  scalar<string>(
    admin,
    'select public.admin_save_sponsorship_package(null, $1, $2, $3, $4, $5, true, 1::smallint)',
    [placement, `Pacote ${placement}`, days, price, maxActive],
  );

async function buy(listingId: string, pkg: string) {
  const begun = await scalar<{ campaign_id: string; price_cents: number }>(
    supplier,
    'select public.sponsorship_begin($1, $2)',
    [listingId, pkg],
  );
  await service('select public.sponsorship_attach_checkout($1, $2)', [
    begun.campaign_id,
    'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=1',
  ]);
  return begun;
}

const pay = (campaign: string, paymentId: string, amount: number, status = 'approved') =>
  service<string>('select public.sponsorship_sync_payment($1)', [
    JSON.stringify({
      external_id: paymentId,
      external_reference: campaign,
      status,
      amount_cents: amount,
    }),
  ]);

type Overview = {
  can_manage: boolean;
  packages: { id: string; sold_out: boolean }[];
  listings: { id: string }[];
  campaigns: { id: string; status: string; live: boolean; views: number; imports: number }[];
};

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  seller2 = await signUpUser(db, 'vend2@example.com', { full_name: 'Vendedor 2' });
  supplier = await signUpUser(db, 'forn@example.com', { full_name: 'F', account_type: 'supplier' });
  supplierMember = await signUpUser(db, 'fm@example.com', {
    full_name: 'FM',
    account_type: 'supplier',
  });
  admin = await signUpUser(db, 'staff@example.com', { full_name: 'Equipe' });
  await db.query("update public.profiles set role = 'admin' where id = $1", [admin]);
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  await scalar(seller2, "select public.create_organization('Loja Dois')");
  supplierOrg = await scalar(supplier, "select public.create_organization('Fábrica X')");
  const inv = await scalar<string>(
    supplier,
    "select public.invite_member($1, 'fm@example.com', 'member')",
    [supplierOrg],
  );
  await scalar(supplierMember, 'select public.accept_invitation($1)', [inv]);
});

afterEach(async () => {
  await db.close();
});

describe('pacotes', () => {
  it('só a equipe cadastra; fornecedor vê os ativos', async () => {
    await expect(
      scalar(
        supplier,
        "select public.admin_save_sponsorship_package(null, 'catalog', 'X', 7, 1000, null, true, 1::smallint)",
      ),
    ).rejects.toThrow(/admin/);
    await expect(savePackage('catalog', 50)).rejects.toThrow(/sponsorship.invalid/);
    await savePackage('catalog', 2990);
    const a = await listing('A');
    const o = await scalar<Overview>(supplierMember, 'select public.sponsorship_overview($1)', [
      supplierOrg,
    ]);
    expect(o.can_manage).toBe(false);
    expect(o.packages).toHaveLength(1);
    expect(o.listings.map((l) => l.id)).toEqual([a]);
    await expect(
      scalar(seller, 'select public.sponsorship_overview($1)', [sellerOrg]),
    ).rejects.toThrow(/sponsorship.suppliers_only/);
    expect(
      (
        await db.query(
          "select count(*)::int as n from public.admin_audit_log where action = 'sponsorship.package'",
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  });
});

describe('compra e campanha', () => {
  it('pagamento aprovado põe no ar, primeiro no catálogo, com resultados reais', async () => {
    const pkg = await savePackage('catalog', 2990);
    const a = await listing('A');
    const b = await listing('B');
    await expect(
      scalar(supplierMember, 'select public.sponsorship_begin($1, $2)', [b, pkg]),
    ).rejects.toThrow(/org.forbidden/);
    const begun = await buy(b, pkg);
    expect(begun.price_cents).toBe(2990);
    // Repetir devolve o mesmo link.
    expect(
      (
        await scalar<{ campaign_id: string }>(supplier, 'select public.sponsorship_begin($1, $2)', [
          b,
          pkg,
        ])
      ).campaign_id,
    ).toBe(begun.campaign_id);
    await expect(
      scalar(seller, "select public.sponsorship_sync_payment('{}'::jsonb)"),
    ).rejects.toThrow(/permission denied/);

    expect(await pay(begun.campaign_id, '100', 2990, 'pending')).toBe('pending');
    expect(await pay(begun.campaign_id, '100', 2990)).toBe('activated');
    expect(await pay(begun.campaign_id, '100', 2990)).toBe('unchanged');
    // Segundo pagamento da mesma compra: estorno.
    expect(await pay(begun.campaign_id, '101', 2990)).toBe('refund_required');
    expect(
      (
        await db.query(
          "select title from public.notifications where user_id = $1 and kind = 'sponsorship.active'",
          [supplier],
        )
      ).rows,
    ).toEqual([{ title: 'Patrocínio no ar' }]);

    const browse = await rows<{ listing_id: string; sponsored: boolean }>(
      seller,
      'select listing_id, sponsored from public.catalog_browse(null, null, 24, 0)',
    );
    expect(browse.map((r) => [r.listing_id, r.sponsored])).toEqual([
      [b, true],
      [a, false],
    ]);
    // Só no espaço comprado: a Central de Vendas não mostra como patrocinado.
    const center = await rows<{ sponsored: boolean }>(
      seller,
      "select sponsored from public.sales_center('new', null, 24, 0)",
    );
    expect(center.every((r) => !r.sponsored)).toBe(true);
    await expect(
      scalar(supplier, 'select public.sponsorship_begin($1, $2)', [b, pkg]),
    ).rejects.toThrow(/sponsorship.already_live/);

    // Resultados: vendedores que abriram (uma vez por empresa) e importaram.
    await scalar(seller, 'select public.sponsorship_record_view($1)', [b]);
    await scalar(seller, 'select public.sponsorship_record_view($1)', [b]);
    await scalar(seller2, 'select public.sponsorship_record_view($1)', [b]);
    await scalar(seller, 'select public.sponsorship_record_view($1)', [a]);
    await scalar(seller, "select public.import_catalog_listing($1, $2, 'IMP')", [sellerOrg, b]);
    const o = await scalar<Overview>(supplier, 'select public.sponsorship_overview($1)', [
      supplierOrg,
    ]);
    expect(o.campaigns[0]).toMatchObject({ status: 'active', live: true, views: 2, imports: 1 });

    // Estorno encerra.
    expect(await pay(begun.campaign_id, '100', 2990, 'refunded')).toBe('ended');
    expect(
      (
        await rows<{ sponsored: boolean }>(
          seller,
          'select sponsored from public.catalog_browse(null, null, 24, 0)',
        )
      ).some((r) => r.sponsored),
    ).toBe(false);
  });

  it('valor diferente, compra trocada e espaço esgotado pedem estorno', async () => {
    const pkg = await savePackage('sales_center', 5000, 1);
    const pkg2 = await savePackage('sales_center', 9000, null, 14);
    const a = await listing('A');
    const b = await listing('B');

    const first = await buy(a, pkg);
    expect(await pay(first.campaign_id, '200', 100)).toBe('refund_required');
    // Trocou de pacote: a compra antiga fica sem efeito.
    const second = await buy(a, pkg2);
    expect(second.campaign_id).not.toBe(first.campaign_id);
    expect(await pay(first.campaign_id, '201', 5000)).toBe('refund_required');
    expect(await pay(second.campaign_id, '202', 9000)).toBe('activated');

    const center = await rows<{ listing_id: string; sponsored: boolean }>(
      seller,
      "select listing_id, sponsored from public.sales_center('trending', null, 24, 0)",
    );
    expect(center[0]).toEqual({ listing_id: a, sponsored: true });

    // Vaga única do pacote: esgota com uma campanha no ar.
    const c1 = await buy(b, pkg);
    const pending = await listing('C');
    const c2 = await buy(pending, pkg);
    expect(await pay(c1.campaign_id, '300', 5000)).toBe('activated');
    let o = await scalar<Overview>(supplier, 'select public.sponsorship_overview($1)', [
      supplierOrg,
    ]);
    expect(o.packages.find((p) => p.id === pkg)!.sold_out).toBe(true);
    await expect(
      scalar(supplier, 'select public.sponsorship_begin($1, $2)', [pending, pkg]),
    ).rejects.toThrow(/sponsorship.sold_out/);
    expect(await pay(c2.campaign_id, '301', 5000)).toBe('refund_required');

    // Terminou o prazo: sai do ar e libera a vaga.
    await db.query(
      "update public.sponsored_campaigns set ends_at = now() - interval '1 minute', starts_at = now() - interval '8 days' where status = 'active'",
    );
    o = await scalar<Overview>(supplier, 'select public.sponsorship_overview($1)', [supplierOrg]);
    expect(o.packages.find((p) => p.id === pkg)!.sold_out).toBe(false);
    expect(o.campaigns.filter((c) => c.live)).toEqual([]);
  });
});
