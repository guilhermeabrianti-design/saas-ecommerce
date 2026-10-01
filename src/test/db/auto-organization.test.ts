// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

const ensure = (user: string, code: string | null = null) =>
  scalar<string>(user, 'select public.ensure_my_organization($1)', [code]);

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await db.close();
});

describe('organização automática no primeiro acesso', () => {
  it('cria do tipo da conta, com nome provisório, e devolve a mesma depois', async () => {
    const supplier = await signUpUser(db, 'forn@example.com', {
      full_name: 'Ana Souza',
      account_type: 'supplier',
    });
    const seller = await signUpUser(db, 'vend@example.com', { full_name: 'Bruno Lima' });

    const s1 = await ensure(supplier);
    expect(await ensure(supplier)).toBe(s1);
    const v1 = await ensure(seller);

    expect(
      (
        await db.query(
          `select o.name, o.kind, o.approval_status, m.role from public.organizations o
           join public.organization_members m on m.organization_id = o.id order by o.kind`,
        )
      ).rows,
    ).toEqual([
      { name: 'Loja de Bruno', kind: 'seller', approval_status: 'approved', role: 'owner' },
      { name: 'Fornecedor Ana Souza', kind: 'supplier', approval_status: 'pending', role: 'owner' },
    ]);
    expect(v1).not.toBe(s1);
  });

  it('quem já tem organização (criada ou por convite) não ganha outra', async () => {
    const owner = await signUpUser(db, 'dono@example.com', { full_name: 'Dono' });
    const member = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
    const org = await scalar<string>(owner, "select public.create_organization('Loja Real')");
    expect(await ensure(owner)).toBe(org);
    const inv = await scalar<string>(
      owner,
      "select public.invite_member($1, 'membro@example.com', 'member')",
      [org],
    );
    await scalar(member, 'select public.accept_invitation($1)', [inv]);
    expect(await ensure(member)).toBe(org);
    expect((await db.query('select count(*)::int as n from public.organizations')).rows).toEqual([
      { n: 1 },
    ]);
  });

  it('código de indicação inválido ou programa pausado não impede; equipe e anônimo não', async () => {
    const seller = await signUpUser(db, 'vend@example.com', { full_name: 'Bruno Lima' });
    await expect(ensure(seller, 'nao-existe')).resolves.toBeTruthy();

    const staff = await signUpUser(db, 'staff@example.com', { full_name: 'Equipe' });
    await db.query("update public.profiles set role = 'admin' where id = $1", [staff]);
    await expect(ensure(staff)).rejects.toThrow(/org.account_type_not_allowed/);
    await expect(scalar(null, 'select public.ensure_my_organization(null)')).rejects.toThrow(
      /permission denied/,
    );
  });
});
