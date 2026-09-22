// @vitest-environment node
import type { PGlite, Transaction } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await db.close();
});

/** Calls an RPC as `userId` and returns its first column of the first row. */
async function rpc<T = unknown>(
  userId: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    const row = res.rows[0];
    return (row ? Object.values(row)[0] : undefined) as T;
  });
}

const createOrg = (userId: string, name: string) =>
  rpc<string>(userId, 'select public.create_organization($1)', [name]);

const invite = (userId: string, org: string, email: string, role = 'member') =>
  rpc<string>(userId, 'select public.invite_member($1, $2, $3)', [org, email, role]);

const accept = (userId: string, invitation: string) =>
  rpc<string>(userId, 'select public.accept_invitation($1)', [invitation]);

async function memberRole(org: string, userId: string) {
  const res = await db.query<{ role: string }>(
    'select role from public.organization_members where organization_id = $1 and user_id = $2',
    [org, userId],
  );
  return res.rows[0]?.role;
}

function selectAll(tx: Transaction, table: string) {
  return tx.query<{ id?: string; organization_id?: string }>(`select * from public.${table}`);
}

describe('organizações: criação', () => {
  it('cria a organização com o tipo da conta e torna o criador owner', async () => {
    const ana = await signUpUser(db, 'ana@example.com', {
      full_name: 'Ana',
      account_type: 'supplier',
    });
    const org = await createOrg(ana, '  Fornecedora Ana  ');

    const res = await db.query<{ name: string; kind: string; created_by: string }>(
      'select name, kind, created_by from public.organizations where id = $1',
      [org],
    );
    expect(res.rows[0]).toEqual({ name: 'Fornecedora Ana', kind: 'supplier', created_by: ana });
    expect(await memberRole(org, ana)).toBe('owner');
  });

  it('rejeita nome inválido', async () => {
    const ana = await signUpUser(db, 'ana@example.com', { full_name: 'Ana' });
    await expect(createOrg(ana, 'x')).rejects.toThrow(/check constraint/);
  });

  it('anon não cria organizações', async () => {
    await expect(rpc(null, "select public.create_organization('Loja X')")).rejects.toThrow(
      /permission denied/,
    );
  });

  it('conta da equipe TheSigns (admin) não cria organizações de cliente', async () => {
    const staff = await signUpUser(db, 'staff@example.com', { full_name: 'Staff' });
    await db.query("update public.profiles set role = 'admin' where id = $1", [staff]);
    await expect(createOrg(staff, 'Loja X')).rejects.toThrow(/org.account_type_not_allowed/);
  });

  it('limita a 10 organizações criadas por usuário', async () => {
    const ana = await signUpUser(db, 'ana@example.com', { full_name: 'Ana' });
    for (let i = 0; i < 10; i++) await createOrg(ana, `Loja ${i}`);
    await expect(createOrg(ana, 'Loja 11')).rejects.toThrow(/org.limit_reached/);
  });

  it('usuário não insere organizações nem membros diretamente', async () => {
    const ana = await signUpUser(db, 'ana@example.com', { full_name: 'Ana' });
    const org = await createOrg(ana, 'Loja Ana');
    await expect(
      asUser(db, ana, (tx) =>
        tx.query("insert into public.organizations (name, kind) values ('Outra', 'seller')"),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(db, ana, (tx) =>
        tx.query(
          "insert into public.organization_members (organization_id, user_id, role) values ($1, gen_random_uuid(), 'owner')",
          [org],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(db, ana, (tx) =>
        tx.query("update public.organization_members set role = 'member' where user_id = $1", [
          ana,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('organizações: isolamento entre tenants', () => {
  let alice: string;
  let bob: string;
  let orgA: string;
  let orgB: string;

  beforeEach(async () => {
    alice = await signUpUser(db, 'alice@example.com', { full_name: 'Alice' });
    bob = await signUpUser(db, 'bob@example.com', { full_name: 'Bob' });
    orgA = await createOrg(alice, 'Loja Alice');
    orgB = await createOrg(bob, 'Loja Bob');
    await invite(bob, orgB, 'bob-convidado@example.com');
  });

  it('usuário vê apenas as próprias organizações e membros', async () => {
    const [orgs, members, invitations] = await asUser(db, alice, async (tx) => [
      (await selectAll(tx, 'organizations')).rows.map((r) => r.id),
      (await selectAll(tx, 'organization_members')).rows.map((r) => r.organization_id),
      (await selectAll(tx, 'organization_invitations')).rows,
    ]);
    expect(orgs).toEqual([orgA]);
    expect(members).toEqual([orgA]);
    expect(invitations).toEqual([]);
  });

  it('anon não lê nenhuma tabela de organização', async () => {
    for (const table of ['organizations', 'organization_members', 'organization_invitations']) {
      await expect(asUser(db, null, (tx) => selectAll(tx, table))).rejects.toThrow(
        /permission denied/,
      );
    }
  });

  it('usuário não renomeia organização alheia', async () => {
    const affected = await asUser(db, alice, async (tx) => {
      const res = await tx.query("update public.organizations set name = 'Hacked' where id = $1", [
        orgB,
      ]);
      return res.affectedRows;
    });
    expect(affected).toBe(0);
  });

  it('owner renomeia a própria organização, mas não muda o tipo', async () => {
    await asUser(db, alice, (tx) =>
      tx.query("update public.organizations set name = 'Loja Alice 2' where id = $1", [orgA]),
    );
    const res = await db.query<{ name: string }>(
      'select name from public.organizations where id = $1',
      [orgA],
    );
    expect(res.rows[0]?.name).toBe('Loja Alice 2');
    await expect(
      asUser(db, alice, (tx) =>
        tx.query("update public.organizations set kind = 'supplier' where id = $1", [orgA]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('RPCs recusam organização alheia', async () => {
    await expect(
      rpc(alice, 'select * from public.list_organization_members($1)', [orgB]),
    ).rejects.toThrow(/org.forbidden/);
    await expect(invite(alice, orgB, 'x@example.com')).rejects.toThrow(/org.forbidden/);
    await expect(rpc(alice, 'select public.remove_member($1, $2)', [orgB, bob])).rejects.toThrow(
      /org.forbidden/,
    );
    await expect(
      rpc(alice, "select public.update_member_role($1, $2, 'member')", [orgB, bob]),
    ).rejects.toThrow(/org.forbidden/);
  });

  it('não revoga convite de outra organização', async () => {
    const res = await db.query<{ id: string }>('select id from public.organization_invitations');
    await expect(
      rpc(alice, 'select public.revoke_invitation($1)', [res.rows[0]!.id]),
    ).rejects.toThrow(/org.invitation_not_found/);
  });
});

describe('organizações: convites', () => {
  let owner: string;
  let org: string;

  beforeEach(async () => {
    owner = await signUpUser(db, 'owner@example.com', { full_name: 'Owner' });
    org = await createOrg(owner, 'Loja Owner');
  });

  it('convidado vê, aceita e entra com o papel do convite', async () => {
    const carla = await signUpUser(db, 'carla@example.com', { full_name: 'Carla' });
    const inv = await invite(owner, org, '  Carla@Example.com ', 'admin');

    const pending = await asUser(db, carla, async (tx) => {
      const res = await tx.query<{ id: string; organization_name: string; role: string }>(
        'select id, organization_name, role from public.my_pending_invitations()',
      );
      return res.rows;
    });
    expect(pending).toEqual([{ id: inv, organization_name: 'Loja Owner', role: 'admin' }]);

    expect(await accept(carla, inv)).toBe(org);
    expect(await memberRole(org, carla)).toBe('admin');
    const left = await db.query('select 1 from public.organization_invitations');
    expect(left.rows).toHaveLength(0);
  });

  it('ninguém aceita convite endereçado a outro e-mail', async () => {
    const inv = await invite(owner, org, 'carla@example.com');
    const mallory = await signUpUser(db, 'mallory@example.com', { full_name: 'Mallory' });
    await expect(accept(mallory, inv)).rejects.toThrow(/org.invitation_not_found/);
    await expect(rpc(mallory, 'select public.decline_invitation($1)', [inv])).rejects.toThrow(
      /org.invitation_not_found/,
    );
    const visible = await asUser(db, mallory, async (tx) => {
      const res = await tx.query('select * from public.my_pending_invitations()');
      return res.rows;
    });
    expect(visible).toEqual([]);
  });

  it('e-mail não confirmado não vê nem aceita convites', async () => {
    const inv = await invite(owner, org, 'carla@example.com');
    const impostor = await signUpUser(db, 'carla@example.com', { full_name: 'Impostor' });
    await db.query('update auth.users set email_confirmed_at = null where id = $1', [impostor]);
    const visible = await asUser(db, impostor, async (tx) => {
      const res = await tx.query('select * from public.my_pending_invitations()');
      return res.rows;
    });
    expect(visible).toEqual([]);
    await expect(accept(impostor, inv)).rejects.toThrow(/org.invitation_not_found/);
  });

  it('convite expirado não pode ser aceito', async () => {
    const carla = await signUpUser(db, 'carla@example.com', { full_name: 'Carla' });
    const inv = await invite(owner, org, 'carla@example.com');
    await db.query(
      "update public.organization_invitations set expires_at = now() - interval '1 minute'",
    );
    await expect(accept(carla, inv)).rejects.toThrow(/org.invitation_not_found/);
  });

  it('tipo de conta precisa bater com o tipo da organização', async () => {
    const forn = await signUpUser(db, 'forn@example.com', {
      full_name: 'Fornecedor',
      account_type: 'supplier',
    });
    const inv = await invite(owner, org, 'forn@example.com');
    await expect(accept(forn, inv)).rejects.toThrow(/org.account_type_mismatch/);
  });

  it('convidado pode recusar', async () => {
    const carla = await signUpUser(db, 'carla@example.com', { full_name: 'Carla' });
    const inv = await invite(owner, org, 'carla@example.com');
    await rpc(carla, 'select public.decline_invitation($1)', [inv]);
    expect(await memberRole(org, carla)).toBeUndefined();
  });

  it('reenviar renova o convite em vez de duplicar', async () => {
    const first = await invite(owner, org, 'carla@example.com');
    const second = await invite(owner, org, 'carla@example.com', 'admin');
    expect(second).toBe(first);
    const res = await db.query<{ role: string }>(
      'select role from public.organization_invitations',
    );
    expect(res.rows).toEqual([{ role: 'admin' }]);
  });

  it('não convida quem já é membro nem para owner', async () => {
    await expect(invite(owner, org, 'OWNER@example.com')).rejects.toThrow(/org.already_member/);
    await expect(invite(owner, org, 'x@example.com', 'owner')).rejects.toThrow(/org.invalid_role/);
  });

  it('admin convida só membros; membro comum não convida', async () => {
    const adm = await signUpUser(db, 'adm@example.com', { full_name: 'Adm' });
    const mem = await signUpUser(db, 'mem@example.com', { full_name: 'Mem' });
    await accept(adm, await invite(owner, org, 'adm@example.com', 'admin'));
    await accept(mem, await invite(owner, org, 'mem@example.com'));

    await expect(invite(adm, org, 'x@example.com', 'member')).resolves.toBeTruthy();
    await expect(invite(adm, org, 'y@example.com', 'admin')).rejects.toThrow(/org.invalid_role/);
    await expect(invite(mem, org, 'z@example.com')).rejects.toThrow(/org.forbidden/);

    const seenByMember = await asUser(db, mem, async (tx) => {
      const res = await selectAll(tx, 'organization_invitations');
      return res.rows;
    });
    expect(seenByMember).toEqual([]);
  });
});

describe('organizações: papéis e saída', () => {
  let owner: string;
  let adm: string;
  let mem: string;
  let org: string;

  beforeEach(async () => {
    owner = await signUpUser(db, 'owner@example.com', { full_name: 'Owner' });
    adm = await signUpUser(db, 'adm@example.com', { full_name: 'Adm' });
    mem = await signUpUser(db, 'mem@example.com', { full_name: 'Mem' });
    org = await createOrg(owner, 'Loja Owner');
    await accept(adm, await invite(owner, org, 'adm@example.com', 'admin'));
    await accept(mem, await invite(owner, org, 'mem@example.com'));
  });

  it('membros listam os colegas com nome e e-mail', async () => {
    const rows = await asUser(db, mem, async (tx) => {
      const res = await tx.query<{ email: string; role: string }>(
        'select email, role from public.list_organization_members($1)',
        [org],
      );
      return res.rows;
    });
    expect(rows).toEqual([
      { email: 'owner@example.com', role: 'owner' },
      { email: 'adm@example.com', role: 'admin' },
      { email: 'mem@example.com', role: 'member' },
    ]);
  });

  it('só owner altera papéis', async () => {
    await expect(
      rpc(adm, "select public.update_member_role($1, $2, 'admin')", [org, mem]),
    ).rejects.toThrow(/org.forbidden/);
    await rpc(owner, "select public.update_member_role($1, $2, 'admin')", [org, mem]);
    expect(await memberRole(org, mem)).toBe('admin');
  });

  it('o último owner não é rebaixado, removido nem sai', async () => {
    await expect(
      rpc(owner, "select public.update_member_role($1, $2, 'admin')", [org, owner]),
    ).rejects.toThrow(/org.last_owner/);
    await expect(rpc(owner, 'select public.remove_member($1, $2)', [org, owner])).rejects.toThrow(
      /org.last_owner/,
    );
    // Com um segundo owner, o primeiro pode sair.
    await rpc(owner, "select public.update_member_role($1, $2, 'owner')", [org, adm]);
    await rpc(owner, 'select public.remove_member($1, $2)', [org, owner]);
    expect(await memberRole(org, owner)).toBeUndefined();
  });

  it('admin remove membro comum, mas não outro admin ou owner', async () => {
    const adm2 = await signUpUser(db, 'adm2@example.com', { full_name: 'Adm 2' });
    await accept(adm2, await invite(owner, org, 'adm2@example.com', 'admin'));

    await expect(rpc(adm, 'select public.remove_member($1, $2)', [org, adm2])).rejects.toThrow(
      /org.forbidden/,
    );
    await expect(rpc(adm, 'select public.remove_member($1, $2)', [org, owner])).rejects.toThrow(
      /org.forbidden/,
    );
    await rpc(adm, 'select public.remove_member($1, $2)', [org, mem]);
    expect(await memberRole(org, mem)).toBeUndefined();
  });

  it('membro comum sai, mas não remove ninguém', async () => {
    await expect(rpc(mem, 'select public.remove_member($1, $2)', [org, adm])).rejects.toThrow(
      /org.forbidden/,
    );
    await rpc(mem, 'select public.remove_member($1, $2)', [org, mem]);
    expect(await memberRole(org, mem)).toBeUndefined();
  });

  it('membro comum não renomeia a organização', async () => {
    const affected = await asUser(db, mem, async (tx) => {
      const res = await tx.query("update public.organizations set name = 'Hacked' where id = $1", [
        org,
      ]);
      return res.affectedRows;
    });
    expect(affected).toBe(0);
  });

  it('quem sai perde o acesso imediatamente', async () => {
    await rpc(mem, 'select public.remove_member($1, $2)', [org, mem]);
    const orgs = await asUser(db, mem, async (tx) => (await selectAll(tx, 'organizations')).rows);
    expect(orgs).toEqual([]);
  });
});
