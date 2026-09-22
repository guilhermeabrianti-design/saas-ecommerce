// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

interface ProfileRow {
  id: string;
  full_name: string;
  role: string;
  updated_at: string;
}

let db: PGlite;

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await db.close();
});

async function profileOf(id: string) {
  const res = await db.query<ProfileRow>('select * from public.profiles where id = $1', [id]);
  return res.rows[0];
}

describe('profiles: criação no cadastro', () => {
  it('cria perfil de vendedor por padrão', async () => {
    const id = await signUpUser(db, 'ana@example.com', { full_name: 'Ana Souza' });
    expect(await profileOf(id)).toMatchObject({ full_name: 'Ana Souza', role: 'seller' });
  });

  it('respeita o pedido de conta de fornecedor', async () => {
    const id = await signUpUser(db, 'forn@example.com', {
      full_name: 'Fornecedor X',
      account_type: 'supplier',
    });
    expect((await profileOf(id))?.role).toBe('supplier');
  });

  it('nunca concede admin a partir dos metadados do cliente', async () => {
    const id = await signUpUser(db, 'evil@example.com', {
      full_name: 'Mallory',
      account_type: 'admin',
    });
    expect((await profileOf(id))?.role).toBe('seller');
  });

  it('usa um nome padrão quando o nome enviado é inválido', async () => {
    const id = await signUpUser(db, 'x@example.com', { full_name: ' a ' });
    expect((await profileOf(id))?.full_name).toBe('Usuário');
  });

  it('remove o perfil quando o usuário é excluído', async () => {
    const id = await signUpUser(db, 'bye@example.com', { full_name: 'Bye Bye' });
    await db.query('delete from auth.users where id = $1', [id]);
    expect(await profileOf(id)).toBeUndefined();
  });
});

describe('profiles: RLS e privilégios', () => {
  let alice: string;
  let bob: string;

  beforeEach(async () => {
    alice = await signUpUser(db, 'alice@example.com', { full_name: 'Alice' });
    bob = await signUpUser(db, 'bob@example.com', { full_name: 'Bob' });
  });

  it('usuário lê apenas o próprio perfil', async () => {
    const rows = await asUser(db, alice, async (tx) => {
      const res = await tx.query<ProfileRow>('select id from public.profiles');
      return res.rows;
    });
    expect(rows.map((r) => r.id)).toEqual([alice]);
  });

  it('anon não tem acesso aos perfis', async () => {
    await expect(
      asUser(db, null, (tx) => tx.query('select * from public.profiles')),
    ).rejects.toThrow(/permission denied/);
  });

  it('usuário atualiza o próprio nome e updated_at muda', async () => {
    const before = await profileOf(alice);
    await asUser(db, alice, (tx) =>
      tx.query("update public.profiles set full_name = 'Alice Lima' where id = $1", [alice]),
    );
    const after = await profileOf(alice);
    expect(after?.full_name).toBe('Alice Lima');
    expect(new Date(after!.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before!.updated_at).getTime(),
    );
  });

  it('usuário não altera o perfil de outra pessoa', async () => {
    const affected = await asUser(db, alice, async (tx) => {
      const res = await tx.query("update public.profiles set full_name = 'Hacked' where id = $1", [
        bob,
      ]);
      return res.affectedRows;
    });
    expect(affected).toBe(0);
    expect((await profileOf(bob))?.full_name).toBe('Bob');
  });

  it('usuário não consegue alterar o próprio papel', async () => {
    await expect(
      asUser(db, alice, (tx) =>
        tx.query("update public.profiles set role = 'admin' where id = $1", [alice]),
      ),
    ).rejects.toThrow(/permission denied/);
    expect((await profileOf(alice))?.role).toBe('seller');
  });

  it('usuário não insere nem exclui perfis', async () => {
    await expect(
      asUser(db, alice, (tx) =>
        tx.query("insert into public.profiles (id, full_name) values (gen_random_uuid(), 'X Y')"),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(db, alice, (tx) => tx.query('delete from public.profiles where id = $1', [alice])),
    ).rejects.toThrow(/permission denied/);
  });

  it('usuário não executa a função do trigger diretamente', async () => {
    await expect(
      asUser(db, alice, (tx) => tx.query('select public.handle_new_user()')),
    ).rejects.toThrow();
  });
});
