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
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
  $$;
  grant execute on function auth.jwt() to anon, authenticated;

  create schema storage;
  grant usage on schema storage to anon, authenticated, service_role;
  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets (id),
    name text not null,
    owner uuid default auth.uid(),
    created_at timestamptz default now(),
    unique (bucket_id, name)
  );
  alter table storage.buckets enable row level security;
  alter table storage.objects enable row level security;
  grant all on storage.objects to anon, authenticated, service_role;
  grant select on storage.buckets to anon, authenticated, service_role;
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

/**
 * Runs `fn` as an API request would: role `authenticated` (or `anon` when userId is null).
 * The session is MFA-verified (`aal2`) unless `aal` says otherwise (Fase 26).
 */
export function asUser<T>(
  db: PGlite,
  userId: string | null,
  fn: (tx: Transaction) => Promise<T>,
  aal: 'aal1' | 'aal2' = 'aal2',
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? '']);
    await tx.query("select set_config('request.jwt.claims', $1, true)", [
      userId ? JSON.stringify({ sub: userId, role: 'authenticated', aal }) : '',
    ]);
    await tx.exec(`set local role ${userId ? 'authenticated' : 'anon'}`);
    return fn(tx);
  });
}

/**
 * Moderação (Fase 16): fornecedores e anúncios novos nascem "em análise".
 * Testes que não tratam de moderação aprovam tudo o que existe até aqui.
 */
export async function approveCatalog(db: PGlite): Promise<void> {
  await db.exec(`
    update public.organizations set approval_status = 'approved' where approval_status <> 'approved';
    update public.catalog_listings set moderation_status = 'approved' where moderation_status <> 'approved';
  `);
}

/**
 * Conexão do Mercado Livre pelo fluxo real de OAuth (começa como o
 * usuário, conclui como a Edge Function). `account` = id do usuário lá.
 */
export function connectMercadoLivre(
  db: PGlite,
  userId: string,
  orgId: string,
  account = '777',
  name = 'Minha conta ML',
): Promise<string> {
  return connectMarketplace(db, userId, orgId, 'mercadolivre', account, name);
}

/** Conecta um marketplace pelo fluxo de autorização (estado → conclusão). */
export async function connectMarketplace(
  db: PGlite,
  userId: string,
  orgId: string,
  provider: 'mercadolivre' | 'shopee' | 'tiktok',
  account: string,
  name = 'Minha loja',
): Promise<string> {
  const state = await asUser(db, userId, async (tx) => {
    const res = await tx.query<{ s: string }>('select public.oauth_begin($1, $2, $3, $4) as s', [
      orgId,
      provider,
      name,
      'a'.repeat(43),
    ]);
    return res.rows[0]!.s;
  });
  return db.transaction(async (tx) => {
    await tx.exec('set local role service_role');
    const c = await tx.query<{ c: { organization_id: string; user_id: string; name: string } }>(
      'select public.oauth_consume($1) as c',
      [state],
    );
    const { organization_id, user_id, name: n } = c.rows[0]!.c;
    const res = await tx.query<{ id: string }>(
      'select public.oauth_complete($1, $2, $3, $4, $5, null, null) as id',
      [organization_id, user_id, provider, n, account],
    );
    return res.rows[0]!.id;
  });
}
