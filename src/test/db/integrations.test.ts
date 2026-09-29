// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerMember: string;
let supplier: string;
let outsider: string;
let sellerOrg: string;
let outsiderOrg: string;
let itemA: string;
let itemB: string;
let connection: string;

const SECRET = 'segredo-de-webhook-1234567890';

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

async function rows<T>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, userId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

/** Como a Edge Function: service role, fora da RLS. */
async function service<T>(sql: string, params: unknown[] = []): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec('set local role service_role');
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

const buyer = {
  customer_name: 'Maria Cliente',
  customer_email: 'maria@example.com',
  ship_postal_code: '01310100',
  ship_street: 'Av. Paulista',
  ship_number: '1000',
  ship_district: 'Bela Vista',
  ship_city: 'São Paulo',
  ship_state: 'SP',
};

const ingest = (
  externalId: string,
  items: { external_item_id: string; quantity: number; unit_price_cents?: number }[],
  extra: Record<string, unknown> = {},
  conn = connection,
) =>
  service<string>('select public.ingest_marketplace_order($1, $2, $3)', [
    conn,
    externalId,
    JSON.stringify({ ...buyer, ...extra, items }),
  ]);

const link = (external: string, item: string, userId = seller, conn = connection, sync = true) =>
  scalar<string>(userId, 'select public.link_listing($1, $2, $3, $4)', [
    conn,
    item,
    external,
    sync,
  ]);

const orders = () =>
  db
    .query<{ number: number; status: string; subtotal_cents: number; created_by: string | null }>(
      'select number, status, subtotal_cents, created_by from public.orders order by number',
    )
    .then((r) => r.rows);

const events = (status?: string) =>
  db
    .query<{ kind: string; status: string; message: string; payload: unknown }>(
      `select kind, status, message, payload from public.integration_events
       where ($1::text is null or status::text = $1) order by created_at, kind`,
      [status ?? null],
    )
    .then((r) => r.rows);

const outbox = () =>
  db
    .query<{ available: number; claimed_at: string | null; done_at: string | null }>(
      'select available, claimed_at, done_at from public.stock_sync_outbox order by created_at',
    )
    .then((r) => r.rows);

const adjust = (item: string, qty: number) =>
  scalar(
    seller,
    `select public.adjust_stock($1, $2, '${qty < 0 ? 'loss' : 'purchase'}', null, gen_random_uuid())`,
    [item, qty],
  );

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  sellerMember = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Forn',
    account_type: 'supplier',
  });
  outsider = await signUpUser(db, 'out@example.com', { full_name: 'Outra Loja' });
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  await scalar(supplier, "select public.create_organization('Fábrica X')");
  outsiderOrg = await scalar(outsider, "select public.create_organization('Loja W')");
  const inv = await scalar<string>(
    seller,
    "select public.invite_member($1, 'membro@example.com', 'member')",
    [sellerOrg],
  );
  await scalar(sellerMember, 'select public.accept_invitation($1)', [inv]);

  for (const [sku, price, ref] of [
    ['CANECA', 3000, 'a'],
    ['COPO', 1500, 'b'],
  ] as const) {
    const p = await scalar<string>(
      seller,
      "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, $2, $2, $3, 'active') returning id",
      [sellerOrg, sku, price],
    );
    const item = await scalar<string>(
      seller,
      'select id from public.inventory_items where product_id = $1',
      [p],
    );
    await adjust(item, 10);
    if (ref === 'a') itemA = item;
    else itemB = item;
  }

  connection = await scalar<string>(
    seller,
    "select public.create_connection($1, 'shopify', 'Minha loja', 'Loja.MyShopify.com', $2)",
    [sellerOrg, SECRET],
  );
});

afterEach(async () => {
  await db.close();
});

describe('conexões e segredo', () => {
  it('cria a conexão normalizada e nunca expõe o segredo', async () => {
    const list = await rows<Record<string, unknown>>(
      seller,
      'select * from public.integration_connections',
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      provider: 'shopify',
      external_account_id: 'loja.myshopify.com',
      status: 'active',
    });
    expect(JSON.stringify(list)).not.toContain(SECRET);
    await expect(scalar(seller, 'select secret from public.integration_secrets')).rejects.toThrow(
      /permission denied/,
    );
    const stored = await service<string>('select secret from public.integration_secrets');
    expect(stored).toBe(SECRET);
  });

  it('só owner/admin de organização vendedora criam; provedor ainda indisponível é recusado', async () => {
    const create = (userId: string, org: string, provider = 'woocommerce') =>
      scalar(userId, 'select public.create_connection($1, $2, $3, $4, $5)', [
        org,
        provider,
        'Outra',
        'https://loja.com.br',
        SECRET,
      ]);
    await expect(create(sellerMember, sellerOrg)).rejects.toThrow(/org.forbidden/);
    await expect(create(outsider, sellerOrg)).rejects.toThrow(/org.forbidden/);
    await expect(create(seller, sellerOrg, 'mercadolivre')).rejects.toThrow(
      /integrations.provider_unavailable/,
    );
    await expect(create(seller, sellerOrg, 'woocommerce')).resolves.toBeTruthy();
    // Fornecedor não tem organização vendedora.
    const supplierOrg = await scalar<string>(
      supplier,
      "select id from public.organizations where kind = 'supplier'",
    );
    await expect(create(supplier, supplierOrg)).rejects.toThrow(/integrations.sellers_only/);
  });

  it('rejeita segredo curto e conexão duplicada', async () => {
    await expect(
      scalar(
        seller,
        "select public.create_connection($1, 'shopify', 'X1', 'a.myshopify.com', 'curto')",
        [sellerOrg],
      ),
    ).rejects.toThrow(/check/);
    await expect(
      scalar(
        seller,
        "select public.create_connection($1, 'shopify', 'Dup', 'LOJA.myshopify.com', $2)",
        [sellerOrg, SECRET],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('só owner/admin da organização leem conexões; outros tenants nada', async () => {
    expect(await rows(sellerMember, 'select 1 from public.integration_connections')).toEqual([]);
    expect(await rows(outsider, 'select 1 from public.integration_connections')).toEqual([]);
    await expect(
      scalar(outsider, 'select public.set_connection_status($1, $2)', [connection, 'paused']),
    ).rejects.toThrow(/integrations.not_found/);
    await expect(
      scalar(outsider, "select public.rotate_connection_secret($1, 'novo-segredo-1234567')", [
        connection,
      ]),
    ).rejects.toThrow(/integrations.not_found/);
  });

  it('rotaciona o segredo; desconectar apaga o segredo e é definitivo', async () => {
    await scalar(seller, "select public.rotate_connection_secret($1, 'novo-segredo-1234567')", [
      connection,
    ]);
    expect(await service<string>('select secret from public.integration_secrets')).toBe(
      'novo-segredo-1234567',
    );

    await scalar(seller, "select public.set_connection_status($1, 'disconnected')", [connection]);
    expect(await service<number>('select count(*) from public.integration_secrets')).toBe(0);
    await expect(
      scalar(seller, "select public.set_connection_status($1, 'active')", [connection]),
    ).rejects.toThrow(/integrations.disconnected/);
    await expect(
      scalar(seller, "select public.rotate_connection_secret($1, 'outro-segredo-1234567')", [
        connection,
      ]),
    ).rejects.toThrow(/integrations.not_found/);
  });
});

describe('vínculos', () => {
  it('vincula e desvincula; SKU e item únicos por conexão', async () => {
    const id = await link('CANECA-SHOP', itemA);
    expect(await rows(seller, 'select 1 from public.listing_links')).toHaveLength(1);
    await expect(link('CANECA-SHOP', itemB)).rejects.toThrow(/duplicate key/);
    await expect(link('OUTRO', itemA)).rejects.toThrow(/duplicate key/);
    await scalar(seller, 'select public.unlink_listing($1)', [id]);
    expect(await rows(seller, 'select 1 from public.listing_links')).toEqual([]);
  });

  it('não vincula estoque de outra organização nem produto com variações sem variação', async () => {
    const foreign = await scalar<string>(
      outsider,
      "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, 'XX', 'Xis', 1, 'active') returning id",
      [outsiderOrg],
    );
    const foreignItem = await scalar<string>(
      outsider,
      'select id from public.inventory_items where product_id = $1',
      [foreign],
    );
    await expect(link('X', foreignItem)).rejects.toThrow(/integrations.invalid_item/);

    const parent = await scalar<string>(
      seller,
      "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, 'PAI', 'Pai', 100, 'active') returning id",
      [sellerOrg],
    );
    await scalar(
      seller,
      `insert into public.product_variants (organization_id, product_id, sku, attributes)
       values ($1, $2, 'PAI-1', '{"Cor":"Azul"}')`,
      [sellerOrg, parent],
    );
    const parentItem = await scalar<string>(
      seller,
      'select id from public.inventory_items where product_id = $1 and variant_id is null',
      [parent],
    );
    await expect(link('PAI', parentItem)).rejects.toThrow(/integrations.invalid_item/);
  });

  it('só owner/admin vinculam', async () => {
    await expect(link('CANECA-SHOP', itemA, sellerMember)).rejects.toThrow(
      /integrations.not_found/,
    );
    await expect(link('CANECA-SHOP', itemA, outsider)).rejects.toThrow(/integrations.not_found/);
  });
});

describe('recebimento de pedidos', () => {
  beforeEach(async () => {
    await link('CANECA-SHOP', itemA);
    await link('COPO-SHOP', itemB);
  });

  it('cria pedido pendente com itens vinculados, sem reservar estoque', async () => {
    const res = await ingest(
      '5001',
      [
        { external_item_id: 'CANECA-SHOP', quantity: 2, unit_price_cents: 3500 },
        { external_item_id: 'COPO-SHOP', quantity: 1, unit_price_cents: 1500 },
      ],
      { shipping_cents: 1000, discount_cents: 500 },
    );
    expect(res).toBe('created');
    expect(await orders()).toEqual([
      { number: 1, status: 'pending', subtotal_cents: 8500, created_by: null },
    ]);
    const total = await db.query<{ total_cents: number }>('select total_cents from public.orders');
    expect(total.rows[0]!.total_cents).toBe(9000);
    const reserved = await db.query<{ reserved: number }>(
      'select reserved from public.inventory_items where id = $1',
      [itemA],
    );
    expect(reserved.rows[0]!.reserved).toBe(0);
    expect((await events('ok'))[0]).toMatchObject({ kind: 'order.created' });
    const ext = await rows(seller, 'select external_id from public.external_orders');
    expect(ext).toEqual([{ external_id: '5001' }]);
  });

  it('é idempotente por pedido externo', async () => {
    const items = [{ external_item_id: 'CANECA-SHOP', quantity: 1, unit_price_cents: 3000 }];
    expect(await ingest('5001', items)).toBe('created');
    expect(await ingest('5001', items)).toBe('duplicate');
    expect(await orders()).toHaveLength(1);
  });

  it('soma linhas do mesmo SKU e recusa preços diferentes para o mesmo SKU', async () => {
    expect(
      await ingest('5002', [
        { external_item_id: 'CANECA-SHOP', quantity: 1, unit_price_cents: 3000 },
        { external_item_id: 'CANECA-SHOP', quantity: 2, unit_price_cents: 3000 },
      ]),
    ).toBe('created');
    const qty = await db.query<{ quantity: number }>('select quantity from public.order_items');
    expect(qty.rows).toEqual([{ quantity: 3 }]);

    expect(
      await ingest('5003', [
        { external_item_id: 'COPO-SHOP', quantity: 1, unit_price_cents: 1500 },
        { external_item_id: 'COPO-SHOP', quantity: 1, unit_price_cents: 1400 },
      ]),
    ).toBe('invalid');
    expect((await events('error'))[0]).toMatchObject({ kind: 'order.invalid' });
    expect(await orders()).toHaveLength(1);
  });

  it('SKU sem vínculo vira evento com payload e não cria pedido; reprocessa depois de vincular', async () => {
    const res = await ingest('5004', [
      { external_item_id: 'CANECA-SHOP', quantity: 1, unit_price_cents: 3000 },
      { external_item_id: 'NOVO-SKU', quantity: 1, unit_price_cents: 999 },
    ]);
    expect(res).toBe('unmapped');
    expect(await orders()).toEqual([]);
    const [err] = await events('error');
    expect(err).toMatchObject({ kind: 'order.unmapped' });
    expect(err!.message).toContain('NOVO-SKU');
    expect(err!.payload).toBeTruthy();

    const eventId = await scalar<string>(
      seller,
      "select id from public.integration_events where status = 'error'",
    );
    // Ainda sem vínculo: continua sem pedido.
    expect(await scalar(seller, 'select public.retry_integration_event($1)', [eventId])).toBe(
      'unmapped',
    );

    const extra = await scalar<string>(
      seller,
      "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, 'NOVO', 'Novo', 999, 'active') returning id",
      [sellerOrg],
    );
    const extraItem = await scalar<string>(
      seller,
      'select id from public.inventory_items where product_id = $1',
      [extra],
    );
    await link('NOVO-SKU', extraItem);
    expect(await scalar(seller, 'select public.retry_integration_event($1)', [eventId])).toBe(
      'created',
    );
    expect(await orders()).toHaveLength(1);
    const done = await db.query<{ status: string; payload: unknown }>(
      'select status, payload from public.integration_events where id = $1',
      [eventId],
    );
    expect(done.rows[0]).toEqual({ status: 'skipped', payload: null });
    await expect(
      scalar(seller, 'select public.retry_integration_event($1)', [eventId]),
    ).rejects.toThrow(/integrations.not_retryable/);
  });

  it('dado inválido do cliente vira evento de erro, não exceção', async () => {
    const res = await ingest(
      '5005',
      [{ external_item_id: 'CANECA-SHOP', quantity: 1, unit_price_cents: 3000 }],
      { ship_state: 'São Paulo' },
    );
    expect(res).toBe('invalid');
    expect(await orders()).toEqual([]);
    expect((await events('error'))[0]!.kind).toBe('order.invalid');
  });

  it('conexão pausada ou desconectada não recebe pedidos', async () => {
    const items = [{ external_item_id: 'CANECA-SHOP', quantity: 1, unit_price_cents: 3000 }];
    await scalar(seller, "select public.set_connection_status($1, 'paused')", [connection]);
    expect(await ingest('5006', items)).toBe('inactive');
    await scalar(seller, "select public.set_connection_status($1, 'active')", [connection]);
    expect(await ingest('5006', items)).toBe('created');
    const ghost = '00000000-0000-4000-8000-000000000000';
    expect(await ingest('5007', items, {}, ghost)).toBe('inactive');
  });

  it('a API autenticada não chama a ingestão nem o worker', async () => {
    for (const fn of [
      "select public.ingest_marketplace_order($1, '1', '{}')",
      'select public.claim_stock_sync(10)',
    ]) {
      await expect(scalar(seller, fn, fn.includes('ingest') ? [connection] : [])).rejects.toThrow(
        /permission denied/,
      );
    }
    await expect(scalar(null, 'select public.claim_stock_sync(10)')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('eventos: só owner/admin leem e só da própria organização', async () => {
    await ingest('5008', [{ external_item_id: 'NAO-EXISTE', quantity: 1 }]);
    expect(await rows(seller, 'select 1 from public.integration_events')).toHaveLength(1);
    // O payload tem dados do cliente e não sai pela API; só o indicador `retryable`.
    await expect(rows(seller, 'select payload from public.integration_events')).rejects.toThrow(
      /permission denied/,
    );
    expect(await rows(seller, 'select retryable from public.integration_events')).toEqual([
      { retryable: true },
    ]);
    for (const user of [sellerMember, outsider, supplier]) {
      expect(await rows(user, 'select 1 from public.integration_events')).toEqual([]);
      expect(await rows(user, 'select 1 from public.external_orders')).toEqual([]);
    }
    const eventId = await scalar<string>(seller, 'select id from public.integration_events');
    await expect(
      scalar(outsider, 'select public.retry_integration_event($1)', [eventId]),
    ).rejects.toThrow(/integrations.not_found/);
  });

  it('pedido manual continua funcionando pelo mesmo núcleo', async () => {
    const id = await scalar<string>(seller, 'select public.create_order($1, $2, $3)', [
      sellerOrg,
      JSON.stringify({ ...buyer, items: [{ inventory_item_id: itemA, quantity: 1 }] }),
      crypto.randomUUID(),
    ]);
    const row = await db.query<{ created_by: string }>(
      'select created_by from public.orders where id = $1',
      [id],
    );
    expect(row.rows[0]!.created_by).toBe(seller);
    await expect(
      scalar(sellerMember, 'select public.create_order($1, $2, $3)', [
        sellerOrg,
        JSON.stringify({ ...buyer, items: [{ inventory_item_id: itemA, quantity: 1 }] }),
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow(/org.forbidden/);
  });
});

describe('estoque de saída', () => {
  it('vincular enfileira o saldo atual; mudanças coalescem numa linha pendente', async () => {
    await link('CANECA-SHOP', itemA);
    expect(await outbox()).toEqual([{ available: 10, claimed_at: null, done_at: null }]);
    await adjust(itemA, 5);
    await adjust(itemA, -3);
    expect(await outbox()).toEqual([{ available: 12, claimed_at: null, done_at: null }]);
  });

  it('reserva de pedido também muda o disponível; vínculo sem sync ou conexão pausada não enfileiram', async () => {
    await link('CANECA-SHOP', itemA);
    await link('COPO-SHOP', itemB, seller, connection, false);
    await scalar(seller, "select public.set_connection_status($1, 'paused')", [connection]);
    await adjust(itemA, 1);
    await adjust(itemB, 1);
    expect(await outbox()).toEqual([{ available: 10, claimed_at: null, done_at: null }]);
  });

  it('desconectar descarta pendências', async () => {
    await link('CANECA-SHOP', itemA);
    await scalar(seller, "select public.set_connection_status($1, 'disconnected')", [connection]);
    expect(await outbox()).toEqual([]);
  });

  it('worker reivindica, conclui e registra o último valor enviado', async () => {
    const linkId = await link('CANECA-SHOP', itemA);
    const claimed = await db.transaction(async (tx) => {
      await tx.exec('set local role service_role');
      return (
        await tx.query<{ id: string; external_id: string; available: number; provider: string }>(
          'select * from public.claim_stock_sync(10)',
        )
      ).rows;
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      external_id: 'CANECA-SHOP',
      available: 10,
      provider: 'shopify',
    });
    // Reivindicada: não sai de novo.
    expect(await service<number>('select count(*) from public.claim_stock_sync(10)')).toBe(0);

    await service('select public.complete_stock_sync($1)', [claimed[0]!.id]);
    const l = await db.query<{ last_pushed_available: number }>(
      'select last_pushed_available from public.listing_links where id = $1',
      [linkId],
    );
    expect(l.rows[0]!.last_pushed_available).toBe(10);
    expect((await outbox())[0]!.done_at).not.toBeNull();
  });

  it('falha recoloca com espera; nova mudança durante o envio não colide; 5 falhas geram evento', async () => {
    await link('CANECA-SHOP', itemA);
    const claim = () =>
      db.transaction(async (tx) => {
        await tx.exec('set local role service_role');
        return (await tx.query<{ id: string }>('select * from public.claim_stock_sync(10)')).rows;
      });

    let [row] = await claim();
    // Estoque muda enquanto o envio está em andamento: nasce nova pendência.
    await adjust(itemA, 2);
    await service('select public.complete_stock_sync($1, $2)', [row!.id, 'timeout']);
    // A antiga ficou obsoleta (já há uma mais nova pendente); sobra só a nova.
    const pending = (await outbox()).filter((o) => o.done_at === null);
    expect(pending).toEqual([{ available: 12, claimed_at: null, done_at: null }]);

    // Falhas repetidas: backoff (não volta imediatamente) e, na 5ª, desiste com evento.
    for (let attempt = 1; attempt <= 5; attempt++) {
      await db.exec(
        'update public.stock_sync_outbox set next_attempt_at = now() where done_at is null',
      );
      [row] = await claim();
      expect(row).toBeDefined();
      await service('select public.complete_stock_sync($1, $2)', [row!.id, 'HTTP 500']);
      if (attempt < 5) {
        expect(await claim()).toEqual([]); // ainda em espera
      }
    }
    expect((await outbox()).filter((o) => o.done_at === null)).toEqual([]);
    expect((await events('error'))[0]).toMatchObject({ kind: 'stock.failed' });
  });
});
