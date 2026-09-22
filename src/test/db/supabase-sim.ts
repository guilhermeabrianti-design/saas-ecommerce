import { PGlite, type Transaction } from '@electric-sql/pglite';

/**
 * Minimal emulation of what a Supabase database provides before our
 * migrations run: the `anon`/`authenticated` roles with Supabase's default
 * grants on `public`, and an `auth` schema with `users` and `auth.uid()`.
 * Lets RLS policies be tested for real without Docker.
 */
const SUPABASE_BOOTSTRAP = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

  create schema auth;
  grant usage on schema auth to anon, authenticated;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text not null,
    email_confirmed_at timestamptz default now(),
    raw_user_meta_data jsonb not null default '{}'::jsonb
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant execute on function auth.uid() to anon, authenticated;
`;

const migrations = import.meta.glob<string>('/supabase/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});

let template: Promise<File | Blob> | undefined;

/** Bootstraps and migrates once per test file, then snapshots the data directory. */
async function buildTemplate(): Promise<File | Blob> {
  const db = new PGlite();
  await db.exec(SUPABASE_BOOTSTRAP);
  for (const path of Object.keys(migrations).sort()) {
    await db.exec(migrations[path] ?? '');
  }
  const snapshot = await db.dumpDataDir('none');
  await db.close();
  return snapshot;
}

/** A fresh, fully migrated database (restored from the per-file snapshot). */
export async function createTestDatabase(): Promise<PGlite> {
  template ??= buildTemplate();
  const db = new PGlite({ loadDataDir: await template });
  await db.waitReady;
  return db;
}

/** Inserts a user the way Supabase Auth does on sign-up (fires our triggers). */
export async function signUpUser(
  db: PGlite,
  email: string,
  metadata: Record<string, unknown> = {},
): Promise<string> {
  const res = await db.query<{ id: string }>(
    'insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id',
    [email, JSON.stringify(metadata)],
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error('user insert returned no id');
  return id;
}

/** Runs `fn` as an API request would: role `authenticated` (or `anon` when userId is null). */
export function asUser<T>(
  db: PGlite,
  userId: string | null,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? '']);
    await tx.exec(`set local role ${userId ? 'authenticated' : 'anon'}`);
    return fn(tx);
  });
}
