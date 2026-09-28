// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { approveCatalog, asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let other: string;
let supplier: string;
let admin: string;
let sellerOrg: string;
let supplierOrg: string;
let listing: string;

async function scalar<T>(
  userId: string | null,
  sql: string,
  params: unknown[] = [],
  aal: 'aal1' | 'aal2' = 'aal2',
): Promise<T> {
  return asUser(
    db,
    userId,
    async (tx) => {
      const res = await tx.query<Record<string, T>>(sql, params);
      return Object.values(res.rows[0] ?? {})[0] as T;
    },
    aal,
  );
}

const rows = <T = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);

const open = (
  user: string,
  opts: {
    org?: string | null;
    category?: string;
    subject?: string;
    order?: string | null;
    code?: string | null;
    listing?: string | null;
  } = {},
) =>
  scalar<string>(user, 'select public.create_support_ticket($1, $2, $3, $4, $5, $6, $7)', [
    opts.org ?? null,
    opts.category ?? 'order',
    opts.subject ?? 'Pedido não chegou',
    'O comprador diz que não recebeu.',
    opts.order ?? null,
    opts.code ?? null,
    opts.listing ?? null,
  ]);

const status = (ticket: string) =>
  db
    .query<{ status: string }>('select status from public.support_tickets where id = $1', [ticket])
    .then((r) => r.rows[0]!.status);

const kinds = (user: string) =>
  rows<{ kind: string }>(user, 'select kind from public.notifications order by created_at').then(
    (r) => r.map((x) => x.kind),
  );

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  other = await signUpUser(db, 'outro@example.com', { full_name: 'Outro' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Forn',
    account_type: 'supplier',
  });
  admin = await signUpUser(db, 'staff@example.com', { full_name: 'Equipe' });
  await db.query("update public.profiles set role = 'admin' where id = $1", [admin]);
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  supplierOrg = await scalar(supplier, "select public.create_organization('Fábrica X')");
  const product = await scalar<string>(
    supplier,
    "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, 'CAM', 'Camiseta', 9000, 'active') returning id",
    [supplierOrg],
  );
  listing = await scalar<string>(
    supplier,
    `insert into public.catalog_listings (organization_id, product_id, wholesale_price_cents, is_published)
     values ($1, $2, 2000, true) returning id`,
    [supplierOrg, product],
  );
  await approveCatalog(db);
  await db.exec('delete from public.notifications');
});

afterEach(async () => {
  await db.close();
});

describe('chamados', () => {
  it('abre, a equipe responde, a pessoa responde e encerra — com avisos dos dois lados', async () => {
    const ticket = await open(seller, { org: sellerOrg });
    expect(await status(ticket)).toBe('open');
    expect(await kinds(admin)).toEqual(['staff.support']);

    await scalar(
      admin,
      "select public.reply_support_ticket($1, 'Vamos verificar com o fornecedor.')",
      [ticket],
    );
    expect(await status(ticket)).toBe('waiting_user');
    expect(await kinds(seller)).toEqual(['support.reply']);

    await scalar(seller, "select public.reply_support_ticket($1, 'Obrigado!')", [ticket]);
    expect(await status(ticket)).toBe('open');

    await scalar(admin, 'select public.close_support_ticket($1)', [ticket]);
    expect(await status(ticket)).toBe('closed');
    expect(await kinds(seller)).toEqual(['support.reply', 'support.closed']);

    // Responder reabre.
    await scalar(seller, "select public.reply_support_ticket($1, 'Ainda não chegou.')", [ticket]);
    expect(await status(ticket)).toBe('open');

    const messages = await rows<{ from_staff: boolean }>(
      seller,
      'select from_staff from public.support_messages where ticket_id = $1 order by created_at',
      [ticket],
    );
    expect(messages.map((m) => m.from_staff)).toEqual([false, true, false, false]);
  });

  it('só quem abriu e a equipe (aal2) veem; ninguém grava direto; mensagens imutáveis', async () => {
    const ticket = await open(seller);
    expect(await scalar(other, 'select count(*)::int from public.support_tickets')).toBe(0);
    expect(await scalar(other, 'select count(*)::int from public.support_messages')).toBe(0);
    await expect(
      scalar(other, "select public.reply_support_ticket($1, 'intrometido')", [ticket]),
    ).rejects.toThrow(/support.not_found/);
    await expect(scalar(other, 'select public.close_support_ticket($1)', [ticket])).rejects.toThrow(
      /support.not_found/,
    );
    expect(await scalar(admin, 'select count(*)::int from public.support_tickets')).toBe(1);
    expect(
      await scalar(admin, 'select count(*)::int from public.support_tickets', [], 'aal1'),
    ).toBe(0);

    await expect(
      scalar(seller, "update public.support_tickets set status = 'closed'"),
    ).rejects.toThrow(/permission denied/);
    await expect(db.query("update public.support_messages set body = 'editado'")).rejects.toThrow();
  });

  it('valida organização, pedido e campos', async () => {
    await expect(open(other, { org: sellerOrg })).rejects.toThrow(/support.forbidden/);
    await expect(open(seller, { order: crypto.randomUUID() })).rejects.toThrow(
      /support.invalid_order/,
    );
    await expect(open(seller, { subject: 'x' })).rejects.toThrow(/support.invalid/);
    await expect(open(null as unknown as string)).rejects.toThrow(/permission denied/);
  });
});

describe('denúncias', () => {
  it('por anúncio visível ou por código público; exige alvo', async () => {
    await expect(open(seller, { category: 'report' })).rejects.toThrow(
      /support.report_target_required/,
    );
    const byListing = await open(seller, {
      category: 'report',
      subject: 'Produto falsificado',
      listing,
    });
    const code = (
      await db.query<{ public_code: string }>(
        'select public_code from public.organizations where id = $1',
        [supplierOrg],
      )
    ).rows[0]!.public_code;
    await open(seller, {
      category: 'report',
      subject: 'Fornecedor não envia',
      code: code.toUpperCase(),
    });
    await expect(
      open(seller, { category: 'report', subject: 'Código errado', code: 'nao-existe' }),
    ).rejects.toThrow(/support.invalid_reported/);

    expect(
      (
        await db.query(
          'select reported_organization_id from public.support_tickets where id = $1',
          [byListing],
        )
      ).rows[0],
    ).toEqual({ reported_organization_id: supplierOrg });
    expect(await kinds(admin)).toEqual(['staff.report', 'staff.report']);

    const context = await scalar<Record<string, unknown>>(
      admin,
      'select public.admin_support_ticket_context($1)',
      [byListing],
    );
    expect(context).toMatchObject({
      requester_email: 'vend@example.com',
      reported_name: 'Fábrica X',
      reported_listing_name: 'Camiseta',
    });
  });
});

describe('fila da equipe', () => {
  it('lista por estado e categoria, com resumo; só equipe', async () => {
    const a = await open(seller, { subject: 'Primeiro' });
    await open(other, { category: 'payment', subject: 'Segundo' });
    await scalar(admin, "select public.reply_support_ticket($1, 'Respondido')", [a]);

    const openList = await rows<{ subject: string; last_from_staff: boolean }>(
      admin,
      "select subject, last_from_staff from public.admin_support_tickets('open', null, 50, 0)",
    );
    expect(openList.map((t) => t.subject)).toEqual(['Segundo']);
    expect(
      (await rows(admin, "select 1 from public.admin_support_tickets('all', 'order', 50, 0)"))
        .length,
    ).toBe(1);
    expect(await scalar(admin, 'select public.admin_support_overview()')).toMatchObject({
      open: 1,
      waiting_user: 1,
    });
    await expect(scalar(seller, 'select public.admin_support_overview()')).rejects.toThrow(
      /admin.forbidden/,
    );
  });

  it('limite: 10 chamados por dia por pessoa', async () => {
    for (let i = 0; i < 10; i++) await open(other, { subject: `Chamado ${i}` });
    await expect(open(other, { subject: 'Mais um' })).rejects.toThrow(/rate_limited/);
  });
});
