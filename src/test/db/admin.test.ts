// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { approveCatalog, asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerMember: string;
let supplier: string;
let outsider: string;
let admin: string;
let sellerOrg: string;
let supplierOrg: string;
let ownItem: string;
let importedItem: string;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

async function rows<T>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, userId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

const customer = {
  customer_name: 'Maria Cliente',
  ship_postal_code: '01310100',
  ship_street: 'Av. Paulista',
  ship_number: '1000',
  ship_district: 'Bela Vista',
  ship_city: 'São Paulo',
  ship_state: 'SP',
};

const createOrder = (items: { inventory_item_id: string; quantity: number }[]) =>
  scalar<string>(seller, 'select public.create_order($1, $2, $3)', [
    sellerOrg,
    JSON.stringify({ ...customer, items }),
    crypto.randomUUID(),
  ]);

const call = (userId: string, fn: string, id: string) =>
  scalar(userId, `select public.${fn}($1)`, [id]);

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  sellerMember = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Forn',
    account_type: 'supplier',
  });
  outsider = await signUpUser(db, 'out@example.com', { full_name: 'Outra Loja' });
  admin = await signUpUser(db, 'staff@example.com', { full_name: 'Equipe' });
  await db.query("update public.profiles set role = 'admin' where id = $1", [admin]);
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  supplierOrg = await scalar(supplier, "select public.create_organization('Fábrica X')");
  await scalar(outsider, "select public.create_organization('Loja W')");
  const inv = await scalar<string>(
    seller,
    "select public.invite_member($1, 'membro@example.com', 'member')",
    [sellerOrg],
  );
  await scalar(sellerMember, 'select public.accept_invitation($1)', [inv]);

  const own = await scalar<string>(
    seller,
    "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, 'PROPRIO', 'Caneca', 3000, 'active') returning id",
    [sellerOrg],
  );
  ownItem = await scalar(seller, 'select id from public.inventory_items where product_id = $1', [
    own,
  ]);
  await scalar(seller, "select public.adjust_stock($1, 10, 'purchase', null, gen_random_uuid())", [
    ownItem,
  ]);

  const sp = await scalar<string>(
    supplier,
    "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, 'CAN', 'Caneca X', 4000, 'active') returning id",
    [supplierOrg],
  );
  const supplierItem = await scalar<string>(
    supplier,
    'select id from public.inventory_items where product_id = $1',
    [sp],
  );
  await scalar(supplier, "select public.adjust_stock($1, 5, 'purchase', null, gen_random_uuid())", [
    supplierItem,
  ]);
  const listing = await scalar<string>(
    supplier,
    `insert into public.catalog_listings (organization_id, product_id, wholesale_price_cents, suggested_price_cents, is_published)
     values ($1, $2, 2000, 5990, true) returning id`,
    [supplierOrg, sp],
  );
  await approveCatalog(db);

  const imported = await scalar<string>(
    seller,
    "select public.import_catalog_listing($1, $2, 'FX-')",
    [sellerOrg, listing],
  );
  await scalar(seller, "update public.products set status = 'active' where id = $1", [imported]);
  importedItem = await scalar(
    seller,
    'select id from public.inventory_items where product_id = $1',
    [imported],
  );
});

afterEach(async () => {
  await db.close();
});

const callAdmin = <T>(sql: string, params: unknown[] = [], userId: string | null = admin) =>
  scalar<T>(userId, sql, params);

const suspend = (org: string, reason: string | null = 'Fraude confirmada', userId = admin) =>
  callAdmin('select public.admin_set_suspension($1, true, $2)', [org, reason], userId);

const reactivate = (org: string, userId = admin) =>
  callAdmin('select public.admin_set_suspension($1, false, null)', [org], userId);

describe('admin: acesso', () => {
  it('só a equipe chama as RPCs de admin', async () => {
    for (const user of [seller, sellerMember, supplier, outsider]) {
      await expect(callAdmin('select public.admin_stats()', [], user)).rejects.toThrow(
        /admin.forbidden/,
      );
      await expect(
        callAdmin('select * from public.admin_list_organizations(null, 10, 0)', [], user),
      ).rejects.toThrow(/admin.forbidden/);
      await expect(
        callAdmin('select * from public.admin_audit_entries(10, 0)', [], user),
      ).rejects.toThrow(/admin.forbidden/);
      await expect(suspend(sellerOrg, 'motivo qualquer', user)).rejects.toThrow(/admin.forbidden/);
    }
    await expect(callAdmin('select public.admin_stats()', [], null)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('admin não lê dados de negócio das organizações', async () => {
    await createOrder([{ inventory_item_id: ownItem, quantity: 1 }]);
    for (const table of [
      'orders',
      'products',
      'inventory_items',
      'organization_members',
      'organizations',
    ]) {
      expect(await rows(admin, `select 1 from public.${table}`)).toEqual([]);
    }
    await expect(rows(admin, 'select 1 from public.admin_audit_log')).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('admin: visão da plataforma', () => {
  it('estatísticas agregadas', async () => {
    await createOrder([{ inventory_item_id: ownItem, quantity: 2 }]);
    const stats = await callAdmin<Record<string, number>>('select public.admin_stats()');
    expect(stats).toMatchObject({
      users: 4,
      sellers: 2,
      suppliers: 1,
      suspended: 0,
      orders_30d: 1,
      gmv_30d_cents: 6000,
      active_connections: 0,
    });
  });

  it('lista organizações com contagens, busca sem coringas e paginação', async () => {
    await createOrder([{ inventory_item_id: ownItem, quantity: 1 }]);
    const all = await rows<{ total_count: number }>(
      admin,
      'select * from public.admin_list_organizations(null, 2, 0)',
    );
    expect(all).toHaveLength(2);
    expect(Number(all[0]!.total_count)).toBe(3);

    const found = await rows<{ name: string; members: number; orders: number }>(
      admin,
      "select * from public.admin_list_organizations('loja v', 10, 0)",
    );
    expect(found.map((o) => [o.name, Number(o.members), Number(o.orders)])).toEqual([
      ['Loja V', 2, 1],
    ]);
    // "%" é texto comum, não coringa.
    expect(await rows(admin, "select * from public.admin_list_organizations('%', 10, 0)")).toEqual(
      [],
    );
  });
});

describe('admin: suspensão', () => {
  it('exige motivo, não repete estado e registra auditoria imutável', async () => {
    await expect(suspend(sellerOrg, null)).rejects.toThrow(/admin.reason_required/);
    await expect(suspend(sellerOrg, 'ab')).rejects.toThrow(/admin.reason_required/);
    await expect(reactivate(sellerOrg)).rejects.toThrow(/admin.no_change/);
    await expect(suspend('00000000-0000-4000-8000-000000000000')).rejects.toThrow(
      /admin.not_found/,
    );

    await suspend(sellerOrg, 'Fraude confirmada');
    await expect(suspend(sellerOrg)).rejects.toThrow(/admin.no_change/);
    await reactivate(sellerOrg);

    const log = await rows<{ action: string; reason: string | null; organization_name: string }>(
      admin,
      'select * from public.admin_audit_entries(10, 0)',
    );
    expect(log.map((l) => l.action)).toEqual([
      'organization.reactivated',
      'organization.suspended',
    ]);
    expect(log[1]).toMatchObject({ reason: 'Fraude confirmada', organization_name: 'Loja V' });
    await expect(db.query('update public.admin_audit_log set action = $1', ['x'])).rejects.toThrow(
      /admin.audit_immutable/,
    );
    await expect(db.query('delete from public.admin_audit_log')).rejects.toThrow(
      /admin.audit_immutable/,
    );
  });

  it('organização suspensa perde acesso a tudo e o motivo aparece só para os membros', async () => {
    const order = await createOrder([{ inventory_item_id: ownItem, quantity: 1 }]);
    await suspend(sellerOrg, 'Documentação inválida');

    for (const user of [seller, sellerMember]) {
      expect(await rows(user, 'select 1 from public.products')).toEqual([]);
      expect(await rows(user, 'select 1 from public.orders')).toEqual([]);
      expect(await rows(user, 'select 1 from public.organization_members')).toEqual([]);
      const mine = await rows<{ name: string; reason: string }>(
        user,
        'select * from public.my_suspended_organizations()',
      );
      expect(mine).toEqual([
        expect.objectContaining({ name: 'Loja V', reason: 'Documentação inválida' }),
      ]);
    }
    await expect(createOrder([{ inventory_item_id: ownItem, quantity: 1 }])).rejects.toThrow(
      /org.forbidden/,
    );
    await expect(call(seller, 'confirm_order', order)).rejects.toThrow(/orders.not_found/);
    await expect(
      scalar(seller, 'select public.analytics_overview($1, 30)', [sellerOrg]),
    ).rejects.toThrow(/org.forbidden/);

    // Terceiros não veem o motivo.
    expect(await rows(outsider, 'select * from public.my_suspended_organizations()')).toEqual([]);

    await reactivate(sellerOrg);
    expect(await rows(seller, 'select 1 from public.orders')).toHaveLength(1);
    expect(await rows(seller, 'select * from public.my_suspended_organizations()')).toEqual([]);
  });

  it('fornecedor suspenso sai do catálogo e não roteia novos pedidos', async () => {
    const order = await createOrder([{ inventory_item_id: importedItem, quantity: 1 }]);
    const visible = () =>
      rows(seller, 'select * from public.search_catalog(null, 10, 0)').then((r) => r.length);
    expect(await visible()).toBe(1);

    await suspend(supplierOrg);
    expect(await visible()).toBe(0);
    await expect(call(seller, 'confirm_order', order)).rejects.toThrow(/orders.source_unavailable/);

    await reactivate(supplierOrg);
    expect(await visible()).toBe(1);
  });

  it('vendedor suspenso não recebe pedidos de marketplace', async () => {
    const conn = await scalar<string>(
      seller,
      "select public.create_connection($1, 'shopify', 'Loja', 'a.myshopify.com', 'segredo-1234567890ab')",
      [sellerOrg],
    );
    await suspend(sellerOrg);
    const res = await db.transaction(async (tx) => {
      await tx.exec('set local role service_role');
      const r = await tx.query<{ r: string }>(
        "select public.ingest_marketplace_order($1, '1', '{}') as r",
        [conn],
      );
      return r.rows[0]!.r;
    });
    expect(res).toBe('inactive');
  });
});
