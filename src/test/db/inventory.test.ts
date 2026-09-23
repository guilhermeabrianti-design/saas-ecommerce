// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let owner: string;
let member: string;
let outsider: string;
let org: string;
let otherOrg: string;
let product: string;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

const newProduct = (userId: string, orgId: string, sku: string) =>
  scalar<string>(
    userId,
    "insert into public.products (organization_id, sku, name, price_cents) values ($1, $2, 'Camiseta', 4990) returning id",
    [orgId, sku],
  );

const newVariant = (sku: string, attrs: object, productId = product) =>
  scalar<string>(
    owner,
    'insert into public.product_variants (organization_id, product_id, sku, attributes) values ($1, $2, $3, $4) returning id',
    [org, productId, sku, JSON.stringify(attrs)],
  );

async function itemOf(productId: string, variantId: string | null = null) {
  const res = await db.query<{ id: string }>(
    'select id from public.inventory_items where product_id = $1 and variant_id is not distinct from $2',
    [productId, variantId],
  );
  return res.rows[0]!.id;
}

const adjust = (
  userId: string,
  item: string,
  delta: number,
  reason = 'purchase',
  requestId: string = crypto.randomUUID(),
) =>
  scalar<number>(userId, 'select public.adjust_stock($1, $2, $3, $4, $5)', [
    item,
    delta,
    reason,
    'nota',
    requestId,
  ]);

const setStock = (userId: string, item: string, qty: number, requestId = crypto.randomUUID()) =>
  scalar<number>(userId, 'select public.set_stock($1, $2, $3, $4)', [item, qty, null, requestId]);

async function onHand(item: string) {
  const res = await db.query<{ on_hand: number }>(
    'select on_hand from public.inventory_items where id = $1',
    [item],
  );
  return res.rows[0]!.on_hand;
}

async function ledgerSum(item: string) {
  const res = await db.query<{ total: number }>(
    'select coalesce(sum(quantity_delta), 0)::int as total from public.inventory_movements where item_id = $1',
    [item],
  );
  return res.rows[0]!.total;
}

beforeEach(async () => {
  db = await createTestDatabase();
  owner = await signUpUser(db, 'owner@example.com', { full_name: 'Owner' });
  member = await signUpUser(db, 'member@example.com', { full_name: 'Member' });
  outsider = await signUpUser(db, 'out@example.com', { full_name: 'Outsider' });
  org = await scalar(owner, "select public.create_organization('Loja Owner')");
  otherOrg = await scalar(outsider, "select public.create_organization('Loja Outsider')");
  const inv = await scalar<string>(
    owner,
    "select public.invite_member($1, 'member@example.com', 'member')",
    [org],
  );
  await scalar(member, 'select public.accept_invitation($1)', [inv]);
  product = await newProduct(owner, org, 'CAM');
});

afterEach(async () => {
  await db.close();
});

describe('inventory: saldos e movimentações', () => {
  it('cria saldo zerado para cada produto e variação', async () => {
    const v = await newVariant('CAM-AZ', { Cor: 'Azul' });
    const res = await db.query<{ variant_id: string | null; on_hand: number }>(
      'select variant_id, on_hand from public.inventory_items order by variant_id nulls first',
    );
    expect(res.rows).toEqual([
      { variant_id: null, on_hand: 0 },
      { variant_id: v, on_hand: 0 },
    ]);
  });

  it('entradas, perdas e contagem mantêm saldo = soma do livro-razão', async () => {
    const item = await itemOf(product);
    expect(await adjust(owner, item, 10)).toBe(10);
    expect(await adjust(owner, item, -3, 'loss')).toBe(7);
    expect(await adjust(owner, item, 2, 'adjustment')).toBe(9);
    expect(await setStock(owner, item, 4)).toBe(4);
    expect(await onHand(item)).toBe(4);
    expect(await ledgerSum(item)).toBe(4);

    const last = await db.query<{ reason: string; quantity_delta: number; created_by: string }>(
      'select reason, quantity_delta, created_by from public.inventory_movements order by created_at desc, on_hand_after limit 1',
    );
    expect(last.rows[0]).toEqual({ reason: 'count', quantity_delta: -5, created_by: owner });
  });

  it('não deixa o saldo ficar negativo', async () => {
    const item = await itemOf(product);
    await adjust(owner, item, 2);
    await expect(adjust(owner, item, -3, 'loss')).rejects.toThrow(/inventory.insufficient_stock/);
    expect(await onHand(item)).toBe(2);
    await expect(setStock(owner, item, -1)).rejects.toThrow(/inventory.invalid_quantity/);
  });

  it('valida sentido da movimentação conforme o motivo', async () => {
    const item = await itemOf(product);
    await expect(adjust(owner, item, -1, 'purchase')).rejects.toThrow(/invalid_quantity/);
    await expect(adjust(owner, item, 1, 'loss')).rejects.toThrow(/invalid_quantity/);
    await expect(adjust(owner, item, 0, 'adjustment')).rejects.toThrow(/invalid_quantity/);
    await expect(adjust(owner, item, 5, 'count')).rejects.toThrow(/invalid_quantity/);
    await expect(adjust(owner, item, 2_000_000)).rejects.toThrow(/invalid_quantity/);
  });

  it('é idempotente pelo request_id (clique duplo / retry)', async () => {
    const item = await itemOf(product);
    const req = crypto.randomUUID();
    expect(await adjust(owner, item, 5, 'purchase', req)).toBe(5);
    expect(await adjust(owner, item, 5, 'purchase', req)).toBe(5);
    expect(await setStock(owner, item, 1, req)).toBe(5);
    expect(await ledgerSum(item)).toBe(5);

    const other = await itemOf(await newProduct(owner, org, 'OUTRO'));
    await expect(adjust(owner, other, 1, 'purchase', req)).rejects.toThrow(
      /inventory.request_reused/,
    );
  });

  it('produto com variações só movimenta estoque nas variações', async () => {
    const productItem = await itemOf(product);
    const v = await newVariant('CAM-AZ', { Cor: 'Azul' });
    await expect(adjust(owner, productItem, 1)).rejects.toThrow(/inventory.use_variants/);
    expect(await adjust(owner, await itemOf(product, v), 3)).toBe(3);
  });

  it('não cria variação em produto que ainda tem saldo próprio', async () => {
    const other = await newProduct(owner, org, 'MEIA');
    await adjust(owner, await itemOf(other), 5);
    await expect(newVariant('MEIA-P', { Tamanho: 'P' }, other)).rejects.toThrow(
      /inventory.product_has_stock/,
    );
  });
});

describe('inventory: permissões e isolamento', () => {
  it('membro lê saldos e histórico, mas não movimenta', async () => {
    const item = await itemOf(product);
    await adjust(owner, item, 3);
    const seen = await asUser(db, member, async (tx) => ({
      levels: (await tx.query('select sku, on_hand from public.inventory_levels')).rows,
      movements: (await tx.query('select 1 from public.inventory_movements')).rows.length,
    }));
    expect(seen).toEqual({ levels: [{ sku: 'CAM', on_hand: 3 }], movements: 1 });
    await expect(adjust(member, item, 1)).rejects.toThrow(/inventory.item_not_found/);
  });

  it('outra organização não vê nem movimenta', async () => {
    const item = await itemOf(product);
    await adjust(owner, item, 3);
    const seen = await asUser(
      db,
      outsider,
      async (tx) => (await tx.query('select 1 from public.inventory_levels')).rows.length,
    );
    expect(seen).toBe(0);
    await expect(adjust(outsider, item, 1)).rejects.toThrow(/inventory.item_not_found/);
    await expect(setStock(outsider, item, 0)).rejects.toThrow(/inventory.item_not_found/);
    expect(await onHand(item)).toBe(3);
  });

  it('ninguém altera saldo ou livro-razão diretamente', async () => {
    const item = await itemOf(product);
    await adjust(owner, item, 3);
    await expect(
      scalar(owner, 'update public.inventory_items set on_hand = 999 where id = $1', [item]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      scalar(
        owner,
        "insert into public.inventory_movements (organization_id, item_id, quantity_delta, on_hand_after, reason, request_id) values ($1, $2, 1, 4, 'purchase', gen_random_uuid())",
        [org, item],
      ),
    ).rejects.toThrow(/permission denied/);
    // Not even the table owner (service role / SQL editor) can rewrite history.
    await expect(
      db.query('update public.inventory_movements set quantity_delta = 99'),
    ).rejects.toThrow(/inventory.ledger_immutable/);
    await expect(db.query('delete from public.inventory_movements')).rejects.toThrow(
      /inventory.ledger_immutable/,
    );
  });

  it('owner/admin definem estoque mínimo; membro não', async () => {
    const item = await itemOf(product);
    await scalar(owner, 'update public.inventory_items set min_quantity = 5 where id = $1', [item]);
    const low = await asUser(
      db,
      owner,
      async (tx) =>
        (await tx.query<{ is_low: boolean }>('select is_low from public.inventory_levels')).rows[0],
    );
    expect(low).toEqual({ is_low: true });
    const affected = await asUser(
      db,
      member,
      async (tx) =>
        (await tx.query('update public.inventory_items set min_quantity = 1 where id = $1', [item]))
          .affectedRows,
    );
    expect(affected).toBe(0);
  });

  it('produto com histórico de estoque não pode ser excluído (arquive)', async () => {
    const item = await itemOf(product);
    await adjust(owner, item, 1);
    await expect(
      scalar(owner, 'delete from public.products where id = $1', [product]),
    ).rejects.toThrow(/inventory.ledger_immutable/);
  });

  it('variação só aparece na visão; o saldo de nível produto some quando há variações', async () => {
    await newVariant('CAM-AZ', { Cor: 'Azul' });
    const skus = await asUser(
      db,
      owner,
      async (tx) =>
        (await tx.query<{ sku: string }>('select sku from public.inventory_levels')).rows,
    );
    expect(skus).toEqual([{ sku: 'CAM-AZ' }]);
  });

  it('não revela saldo de produto alheio pela trava de variação', async () => {
    const theirs = await newProduct(outsider, otherOrg, 'DELES');
    await adjust(outsider, await itemOf(theirs), 5);
    // Owner of `org` trying to add a variant into the other org gets RLS, not "has stock".
    await expect(
      scalar(
        owner,
        'insert into public.product_variants (organization_id, product_id, sku, attributes) values ($1, $2, \'X\', \'{"Cor":"Azul"}\')',
        [otherOrg, theirs],
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
