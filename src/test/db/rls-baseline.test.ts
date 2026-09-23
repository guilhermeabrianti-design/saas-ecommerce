// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { createTestDatabase } from './supabase-sim';

/**
 * Invariants that must hold for the whole schema, not just today's tables.
 * A new migration that forgets RLS, a grant revoke or `search_path` fails here.
 */

/** RPCs deliberately callable by signed-in users. Anything else must not be. */
const AUTHENTICATED_RPCS = [
  'accept_invitation',
  'adjust_stock',
  'create_organization',
  'decline_invitation',
  'invite_member',
  'list_organization_members',
  'my_pending_invitations',
  'remove_member',
  'revoke_invitation',
  'set_product_image_order',
  'set_stock',
  'update_member_role',
];

let db: PGlite;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

describe('RLS deny-by-default', () => {
  it('toda tabela do schema public tem RLS habilitada', async () => {
    const res = await db.query<{ relname: string }>(`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
    `);
    expect(res.rows.map((r) => r.relname)).toEqual([]);
  });

  it('anon não tem privilégio em nenhuma tabela do schema public', async () => {
    const res = await db.query<{ table_name: string; privilege_type: string }>(`
      select table_name, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'anon'
    `);
    expect(res.rows).toEqual([]);
  });

  it('tabelas novas nascem sem acesso para anon/authenticated', async () => {
    await db.exec('create table public.future_table (id int); create sequence public.future_seq;');
    const res = await db.query<Record<string, boolean>>(`
      select
        has_table_privilege('anon', 'public.future_table', 'select') as anon_table,
        has_table_privilege('authenticated', 'public.future_table', 'select,insert,update,delete') as auth_table,
        has_sequence_privilege('authenticated', 'public.future_seq', 'usage') as auth_seq
    `);
    expect(res.rows[0]).toEqual({ anon_table: false, auth_table: false, auth_seq: false });
    await db.exec('drop table public.future_table; drop sequence public.future_seq;');
  });

  it('funções novas nascem sem permissão de execução', async () => {
    await db.exec('create function public.future_fn() returns int language sql as $$ select 1 $$;');
    const res = await db.query<Record<string, boolean>>(`
      select
        has_function_privilege('anon', 'public.future_fn()', 'execute') as anon,
        has_function_privilege('authenticated', 'public.future_fn()', 'execute') as auth
    `);
    expect(res.rows[0]).toEqual({ anon: false, auth: false });
    await db.exec('drop function public.future_fn();');
  });

  it('anon não executa nenhuma função de public/private', async () => {
    const res = await db.query<{ proname: string }>(`
      select p.proname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private')
        and has_function_privilege('anon', p.oid, 'execute')
    `);
    expect(res.rows.map((r) => r.proname)).toEqual([]);
  });

  it('authenticated executa apenas as RPCs previstas no schema public', async () => {
    const res = await db.query<{ proname: string }>(`
      select p.proname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
      order by p.proname
    `);
    expect(res.rows.map((r) => r.proname)).toEqual(AUTHENTICATED_RPCS);
  });

  it('toda função security definer fixa search_path vazio', async () => {
    const res = await db.query<{ proname: string }>(`
      select p.proname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prosecdef
        and not coalesce('search_path=""' = any (p.proconfig), false)
    `);
    expect(res.rows.map((r) => r.proname)).toEqual([]);
  });
});
