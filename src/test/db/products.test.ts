// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let owner: string;
let member: string;
let outsider: string;
let org: string;
let otherOrg: string;

async function scalar<T>(userId: string, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

async function joinAsMember(userId: string, email: string) {
  const inv = await scalar<string>(owner, "select public.invite_member($1, $2, 'member')", [
    org,
    email,
  ]);
  await scalar(userId, 'select public.accept_invitation($1)', [inv]);
}

function insertProduct(userId: string, orgId: string, sku: string, extra = '') {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<{ id: string }>(
      `insert into public.products (organization_id, sku, name, price_cents${extra ? ', status' : ''})
       values ($1, $2, 'Camiseta Básica', 4990${extra ? `, '${extra}'` : ''}) returning id`,
      [orgId, sku],
    );
    return res.rows[0]!.id;
  });
}

async function visibleSkus(userId: string) {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<{ sku: string }>('select sku from public.products order by sku');
    return res.rows.map((r) => r.sku);
  });
}

beforeEach(async () => {
  db = await createTestDatabase();
  owner = await signUpUser(db, 'owner@example.com', { full_name: 'Owner' });
  member = await signUpUser(db, 'member@example.com', { full_name: 'Member' });
  outsider = await signUpUser(db, 'out@example.com', { full_name: 'Outsider' });
  org = await scalar(owner, "select public.create_organization('Loja Owner')");
  otherOrg = await scalar(outsider, "select public.create_organization('Loja Outsider')");
  await joinAsMember(member, 'member@example.com');
});

afterEach(async () => {
  await db.close();
});

describe('products: isolamento e papéis', () => {
  it('owner cria; created_by e datas são preenchidos pelo banco', async () => {
    const id = await insertProduct(owner, org, 'CAM-001');
    const res = await db.query<{ created_by: string; status: string }>(
      'select created_by, status from public.products where id = $1',
      [id],
    );
    expect(res.rows[0]).toEqual({ created_by: owner, status: 'draft' });
  });

  it('membro lê os produtos da organização, mas não cria nem edita', async () => {
    const id = await insertProduct(owner, org, 'CAM-001');
    expect(await visibleSkus(member)).toEqual(['CAM-001']);
    await expect(insertProduct(member, org, 'CAM-002')).rejects.toThrow(/row-level security/);
    const affected = await asUser(db, member, async (tx) => {
      const res = await tx.query('update public.products set price_cents = 1 where id = $1', [id]);
      return res.affectedRows;
    });
    expect(affected).toBe(0);
  });

  it('usuário de outra organização não vê, não edita e não exclui', async () => {
    const id = await insertProduct(owner, org, 'CAM-001');
    expect(await visibleSkus(outsider)).toEqual([]);
    const [updated, deleted] = await asUser(db, outsider, async (tx) => [
      (await tx.query("update public.products set name = 'Hacked' where id = $1", [id]))
        .affectedRows,
      (await tx.query('delete from public.products where id = $1', [id])).affectedRows,
    ]);
    expect([updated, deleted]).toEqual([0, 0]);
  });

  it('não cria produto em organização alheia', async () => {
    await expect(insertProduct(owner, otherOrg, 'X-1')).rejects.toThrow(/row-level security/);
  });

  it('não move produto para outra organização nem forja autoria', async () => {
    const id = await insertProduct(owner, org, 'CAM-001');
    await expect(
      asUser(db, owner, (tx) =>
        tx.query('update public.products set organization_id = $1 where id = $2', [otherOrg, id]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(db, owner, (tx) =>
        tx.query('update public.products set created_by = $1 where id = $2', [outsider, id]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('anon não acessa produtos', async () => {
    await expect(
      asUser(db, null, (tx) => tx.query('select * from public.products')),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('products: regras de dados', () => {
  it('SKU é único por organização sem diferenciar maiúsculas, mas pode repetir entre organizações', async () => {
    await insertProduct(owner, org, 'CAM-001');
    await expect(insertProduct(owner, org, 'cam-001')).rejects.toThrow(/duplicate key/);
    await expect(insertProduct(outsider, otherOrg, 'CAM-001')).resolves.toBeTruthy();
  });

  it('rejeita SKU, GTIN e preço inválidos', async () => {
    await expect(insertProduct(owner, org, 'com espaço')).rejects.toThrow(/check constraint/);
    await expect(
      asUser(db, owner, (tx) =>
        tx.query(
          "insert into public.products (organization_id, sku, name, price_cents, gtin) values ($1, 'A1', 'Nome', 100, '123')",
          [org],
        ),
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      asUser(db, owner, (tx) =>
        tx.query(
          "insert into public.products (organization_id, sku, name, price_cents) values ($1, 'A2', 'Nome', -1)",
          [org],
        ),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('só rascunhos podem ser excluídos', async () => {
    const draft = await insertProduct(owner, org, 'D-1');
    const active = await insertProduct(owner, org, 'A-1', 'active');
    const deleted = await asUser(db, owner, async (tx) => {
      const a = await tx.query('delete from public.products where id = $1', [draft]);
      const b = await tx.query('delete from public.products where id = $1', [active]);
      return [a.affectedRows, b.affectedRows];
    });
    expect(deleted).toEqual([1, 0]);
  });

  it('produtos somem com a organização', async () => {
    await insertProduct(owner, org, 'CAM-001');
    await db.query('delete from public.organizations where id = $1', [org]);
    const res = await db.query('select 1 from public.products');
    expect(res.rows).toHaveLength(0);
  });
});
