// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { approveCatalog, asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerMember: string;
let stranger: string;
let supplier: string;
let sellerOrg: string;
let supplierOrg: string;
let connection: string;

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

const rows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

const mlOrder = (quantity = 1) => ({
  customer_name: 'Maria Compradora',
  customer_phone: '11987654321',
  customer_document: '12345678909',
  ship_postal_code: '01310100',
  ship_street: 'Av. Paulista',
  ship_number: '1000',
  ship_district: 'Bela Vista',
  ship_city: 'São Paulo',
  ship_state: 'SP',
  shipping_cents: 0,
  discount_cents: 0,
  notes: 'Mercado Livre #2000001',
  items: [{ external_item_id: 'FX-CAM', quantity, unit_price_cents: 5990 }],
});

const ingest = (externalId: string, quantity = 1) =>
  service<string>('select public.ingest_marketplace_order($1, $2, $3)', [
    connection,
    externalId,
    JSON.stringify(mlOrder(quantity)),
  ]);

type Forward = {
  status: string;
  forwarded: boolean;
  order_id: string;
  supplier_order_id: string | null;
  target_order_id: string | null;
  existing: string[];
};

const forward = (externalId: string, shipment: string | null = '44') =>
  service<Forward>('select public.ml_forward_order($1, $2, $3)', [
    connection,
    externalId,
    shipment,
  ]);

const attach = (order: string, kind: string, path: string, ref = '1704629', tracking?: string) =>
  service<string>('select public.attach_marketplace_document($1, $2, $3, $4, $5, $6)', [
    order,
    kind,
    path,
    kind === 'label' ? 'etiqueta.pdf' : 'nota-fiscal-28790.pdf',
    ref,
    tracking ?? null,
  ]);

const putFile = (path: string) =>
  service("insert into storage.objects (bucket_id, name) values ('shipping-labels', $1)", [path]);

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  sellerMember = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
  stranger = await signUpUser(db, 'outro@example.com', { full_name: 'Outro' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Forn',
    account_type: 'supplier',
  });
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  await scalar(stranger, "select public.create_organization('Loja W')");
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
  const si = await scalar<string>(
    supplier,
    'select id from public.inventory_items where product_id = $1',
    [sp],
  );
  await scalar(
    supplier,
    "select public.adjust_stock($1, 10, 'purchase', null, gen_random_uuid())",
    [si],
  );
  const listing = await scalar<string>(
    supplier,
    `insert into public.catalog_listings (organization_id, product_id, wholesale_price_cents, is_published)
     values ($1, $2, 2000, true) returning id`,
    [supplierOrg, sp],
  );
  await approveCatalog(db);
  const imported = await scalar<string>(
    seller,
    "select public.import_catalog_listing($1, $2, 'FX-')",
    [sellerOrg, listing],
  );
  await scalar(
    seller,
    "update public.products set status = 'active', price_cents = 5990 where id = $1",
    [imported],
  );
  const item = await scalar<string>(
    seller,
    'select id from public.inventory_items where product_id = $1',
    [imported],
  );

  const state = await scalar<string>(
    seller,
    "select public.oauth_begin($1, 'mercadolivre', 'Minha conta ML', $2)",
    [sellerOrg, 'a'.repeat(43)],
  );
  const c = await service<{ organization_id: string; user_id: string; name: string }>(
    'select public.oauth_consume($1)',
    [state],
  );
  connection = await service<string>(
    "select public.oauth_complete($1, $2, 'mercadolivre', $3, '777', null, null)",
    [c.organization_id, c.user_id, c.name],
  );
  await scalar(seller, "select public.link_listing($1, $2, 'FX-CAM')", [connection, item]);
  await db.exec('delete from public.notifications');
});

afterEach(async () => {
  await db.close();
});

describe('envio automático ao fornecedor', () => {
  it('pedido pago vira fornecimento sozinho; fornecedor é avisado', async () => {
    expect(await ingest('2000001')).toBe('created');
    const f = await forward('2000001');
    expect(f).toMatchObject({ status: 'confirmed', forwarded: true, target_order_id: null });
    expect(f.supplier_order_id).toBeTruthy();
    expect(f.existing).toEqual([]);

    expect(
      await rows('select organization_id, status from public.supplier_orders where order_id = $1', [
        f.order_id,
      ]),
    ).toEqual([{ organization_id: supplierOrg, status: 'pending' }]);
    expect(
      await rows(
        "select organization_id from public.notifications where kind = 'supplier_order.new'",
      ),
    ).toContainEqual({ organization_id: supplierOrg });
    expect(
      await rows(
        "select kind, status from public.integration_events where kind = 'order.forwarded'",
      ),
    ).toEqual([{ kind: 'order.forwarded', status: 'ok' }]);
    expect(await service('select public.ml_external_by_shipment($1, $2)', [connection, '44'])).toBe(
      '2000001',
    );

    // Notificação repetida: não confirma de novo.
    expect(await ingest('2000001')).toBe('duplicate');
    expect(await forward('2000001')).toMatchObject({ status: 'confirmed', forwarded: false });
    expect(
      await rows('select count(*)::int as n from public.supplier_orders where order_id = $1', [
        f.order_id,
      ]),
    ).toEqual([{ n: 1 }]);
  });

  it('desligado: fica pendente; só owner/admin muda', async () => {
    await expect(
      scalar(sellerMember, 'select public.set_connection_auto_forward($1, false)', [connection]),
    ).rejects.toThrow(/integrations.not_found/);
    await expect(
      scalar(stranger, 'select public.set_connection_auto_forward($1, false)', [connection]),
    ).rejects.toThrow(/integrations.not_found/);
    await scalar(seller, 'select public.set_connection_auto_forward($1, false)', [connection]);

    await ingest('2000002');
    expect(await forward('2000002')).toMatchObject({ status: 'pending', forwarded: false });
    expect(await rows('select count(*)::int as n from public.supplier_orders')).toEqual([{ n: 0 }]);
  });

  it('sem estoque: fica pendente, registra o motivo e avisa o vendedor', async () => {
    await ingest('2000003', 50);
    expect(await forward('2000003')).toMatchObject({ status: 'pending', forwarded: false });
    expect(
      await rows(
        "select status, message from public.integration_events where kind = 'order.forward_failed'",
      ),
    ).toEqual([{ status: 'error', message: expect.stringMatching(/estoque insuficiente/) }]);
    expect(
      await rows(
        "select organization_id from public.notifications where kind = 'order.forward_failed'",
      ),
    ).toContainEqual({ organization_id: sellerOrg });
  });
});

describe('etiqueta e nota fiscal do Mercado Livre', () => {
  it('anexa ao fornecimento, sem duplicar; fornecedor lê e é avisado', async () => {
    await ingest('2000001');
    const f = await forward('2000001');
    const folder = `so-${f.supplier_order_id}`;

    await putFile(`${folder}/ml-invoice_pdf-1704629.pdf`);
    await putFile(`${folder}/ml-invoice_xml-1704629.xml`);
    await putFile(`${folder}/ml-label-44.pdf`);
    expect(await attach(f.order_id, 'invoice_pdf', `${folder}/ml-invoice_pdf-1704629.pdf`)).toBe(
      'attached',
    );
    expect(await attach(f.order_id, 'invoice_xml', `${folder}/ml-invoice_xml-1704629.xml`)).toBe(
      'attached',
    );
    expect(await attach(f.order_id, 'label', `${folder}/ml-label-44.pdf`, '44', 'ab12345')).toBe(
      'attached',
    );
    expect(await attach(f.order_id, 'invoice_pdf', `${folder}/ml-invoice_pdf-1704629.pdf`)).toBe(
      'duplicate',
    );
    expect((await forward('2000001')).existing.sort()).toEqual([
      'invoice_pdf:1704629',
      'invoice_xml:1704629',
      'label:44',
    ]);

    const seen = await asUser(
      db,
      supplier,
      async (tx) =>
        (
          await tx.query(
            'select kind, source, carrier, tracking_code from public.shipping_labels order by kind',
          )
        ).rows,
    );
    expect(seen).toEqual([
      { kind: 'invoice_pdf', source: 'mercadolivre', carrier: null, tracking_code: null },
      { kind: 'invoice_xml', source: 'mercadolivre', carrier: null, tracking_code: null },
      {
        kind: 'label',
        source: 'mercadolivre',
        carrier: 'Mercado Envios',
        tracking_code: 'AB12345',
      },
    ]);
    const outsider = await asUser(
      db,
      stranger,
      async (tx) => (await tx.query('select id from public.shipping_labels')).rows,
    );
    expect(outsider).toEqual([]);

    // Um aviso por documento (o XML acompanha a nota).
    expect(
      await rows(
        "select title from public.notifications where kind = 'label.attached' and organization_id = $1 order by title",
        [supplierOrg],
      ),
    ).toEqual([
      { title: expect.stringMatching(/^Etiqueta do Mercado Livre no fornecimento #/) },
      { title: expect.stringMatching(/^Nota fiscal no fornecimento #/) },
    ]);
  });

  it('pasta errada ou arquivo ausente é recusado; tipo inválido também', async () => {
    await ingest('2000001');
    const f = await forward('2000001');
    await putFile(`o-${f.order_id}/x.pdf`);
    await expect(attach(f.order_id, 'invoice_pdf', `o-${f.order_id}/x.pdf`)).rejects.toThrow(
      /labels.file_missing/,
    );
    await expect(
      attach(f.order_id, 'invoice_pdf', `so-${f.supplier_order_id}/nao-existe.pdf`),
    ).rejects.toThrow(/labels.file_missing/);
    await expect(attach(f.order_id, 'contrato', `o-${f.order_id}/x.pdf`)).rejects.toThrow(
      /labels.invalid/,
    );
    // Só o service role chama.
    await expect(
      scalar(seller, 'select public.attach_marketplace_document($1, $2, $3, $4, $5, $6)', [
        f.order_id,
        'label',
        'x',
        'x',
        'x',
        null,
      ]),
    ).rejects.toThrow(/permission denied/);
  });

  it('botão do pedido: membro do vendedor pede; estranho não', async () => {
    await ingest('2000001');
    const f = await forward('2000001');
    expect(
      await asUser(
        db,
        sellerMember,
        async (tx) =>
          (await tx.query('select * from public.ml_documents_request($1)', [f.order_id])).rows,
      ),
    ).toEqual([{ connection_id: connection, external_id: '2000001' }]);
    await expect(
      scalar(stranger, 'select public.ml_documents_request($1)', [f.order_id]),
    ).rejects.toThrow(/orders.not_found/);
  });

  it('upload manual da nota (XML) pelo fornecedor; tipo desconhecido recusado', async () => {
    await ingest('2000001');
    const f = await forward('2000001');
    const path = `so-${f.supplier_order_id}/nota.xml`;
    await scalar(
      supplier,
      "insert into storage.objects (bucket_id, name) values ('shipping-labels', $1)",
      [path],
    );
    await scalar(
      supplier,
      "select public.register_shipping_label($1, null, $2, 'nota.xml', 'X', 'AA1234', 'invoice_xml')",
      [f.supplier_order_id, path],
    );
    expect(
      await rows('select kind, source, carrier, tracking_code from public.shipping_labels'),
    ).toEqual([{ kind: 'invoice_xml', source: 'upload', carrier: null, tracking_code: null }]);
    await expect(
      scalar(
        supplier,
        "select public.register_shipping_label($1, null, $2, 'nota.xml', null, null, 'boleto')",
        [f.supplier_order_id, path],
      ),
    ).rejects.toThrow(/labels.invalid/);
  });
});
