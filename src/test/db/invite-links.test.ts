// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let owner: string;
let org: string;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

const link = (user: string, role = 'member', label: string | null = null) =>
  scalar<string>(user, 'select public.create_invite_link($1, $2, $3)', [org, role, label]);
const accept = (user: string, token: string) =>
  scalar<string>(user, 'select public.accept_invite_link($1)', [token]);
const preview = (user: string | null, token: string) =>
  scalar<Record<string, unknown> | null>(user, 'select public.invite_link_preview($1)', [token]);
const membersOf = async (o: string) =>
  (
    await db.query<{ role: string }>(
      'select role from public.organization_members where organization_id = $1 order by role',
      [o],
    )
  ).rows.map((r) => r.role);

beforeEach(async () => {
  db = await createTestDatabase();
  owner = await signUpUser(db, 'dono@example.com', { full_name: 'Dono' });
  org = await scalar<string>(owner, "select public.create_organization('Loja Real')");
});

afterEach(async () => {
  await db.close();
});

describe('convite por link', () => {
  it('quem abre o link entra na empresa com o acesso escolhido; o link vale uma vez', async () => {
    const token = await link(owner, 'admin', 'Ana do estoque');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // A tela do convite mostra a empresa antes de criar a conta (sem login).
    expect(await preview(null, token)).toMatchObject({
      organization_name: 'Loja Real',
      kind: 'seller',
      role: 'admin',
    });

    const ana = await signUpUser(db, 'ana@example.com', { full_name: 'Ana' });
    expect(await accept(ana, token)).toBe(org);
    expect(await membersOf(org)).toEqual(['owner', 'admin']);

    const outra = await signUpUser(db, 'outra@example.com', { full_name: 'Outra' });
    await expect(accept(outra, token)).rejects.toThrow(/org.invitation_not_found/);
    expect(await preview(null, token)).toBeNull();
  });

  it('a empresa vazia criada no primeiro acesso é trocada; com dados, recusa', async () => {
    const bia = await signUpUser(db, 'bia@example.com', { full_name: 'Bia' });
    const own = await scalar<string>(bia, 'select public.ensure_my_organization(null)');
    expect(await accept(bia, await link(owner))).toBe(org);
    expect(
      (await db.query('select 1 from public.organizations where id = $1', [own])).rows,
    ).toEqual([]);

    const caio = await signUpUser(db, 'caio@example.com', { full_name: 'Caio' });
    const caioOrg = await scalar<string>(caio, 'select public.ensure_my_organization(null)');
    await scalar(
      caio,
      "insert into public.products (organization_id, sku, name, price_cents) values ($1, 'X', 'Produto', 100)",
      [caioOrg],
    );
    await expect(accept(caio, await link(owner))).rejects.toThrow(/org.already_in_company/);
    expect(await membersOf(caioOrg)).toEqual(['owner']);
  });

  it('tipo de conta precisa bater; só owner/admin geram; admin só convida membro', async () => {
    const forn = await signUpUser(db, 'forn@example.com', {
      full_name: 'Forn',
      account_type: 'supplier',
    });
    await expect(accept(forn, await link(owner))).rejects.toThrow(/org.account_type_mismatch/);

    const admin = await signUpUser(db, 'adm@example.com', { full_name: 'Adm' });
    await accept(admin, await link(owner, 'admin'));
    await expect(link(admin, 'admin')).rejects.toThrow(/org.invalid_role/);
    await expect(link(admin, 'member')).resolves.toMatch(/^[0-9a-f]{64}$/);

    const member = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
    await accept(member, await link(owner));
    await expect(link(member)).rejects.toThrow(/org.forbidden/);
    await expect(link(owner, 'owner')).rejects.toThrow(/org.invalid_role/);
  });

  it('vencido, revogado ou inventado não vale; membro não vê os links', async () => {
    const token = await link(owner);
    await db.query(
      "update public.organization_invitations set expires_at = now() - interval '1 minute' where token = $1",
      [token],
    );
    const dani = await signUpUser(db, 'dani@example.com', { full_name: 'Dani' });
    await expect(accept(dani, token)).rejects.toThrow(/org.invitation_not_found/);
    await expect(accept(dani, 'x'.repeat(64))).rejects.toThrow(/org.invitation_not_found/);
    expect(await preview(dani, "' or 1=1 --")).toBeNull();

    const fresh = await link(owner);
    const id = (
      await db.query<{ id: string }>(
        'select id from public.organization_invitations where token = $1',
        [fresh],
      )
    ).rows[0]!.id;
    await scalar(owner, 'select public.revoke_invitation($1)', [id]);
    await expect(accept(dani, fresh)).rejects.toThrow(/org.invitation_not_found/);

    await accept(dani, await link(owner));
    await link(owner);
    expect(
      await asUser(
        db,
        dani,
        async (tx) => (await tx.query('select token from public.organization_invitations')).rows,
      ),
    ).toEqual([]);
  });
});
