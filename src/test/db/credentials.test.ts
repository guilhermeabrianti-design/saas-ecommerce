// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerMember: string;
let supplier: string;
let outsider: string;
let sellerOrg: string;
let connection: string;

const SECRET = 'segredo-de-webhook-1234567890';

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

async function rows<T>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, userId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

/** Como a Edge Function: service role, fora da RLS. */
async function service<T>(sql: string, params: unknown[] = []): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec('set local role service_role');
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  sellerMember = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Forn',
    account_type: 'supplier',
  });
  outsider = await signUpUser(db, 'out@example.com', { full_name: 'Outra Loja' });
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  await scalar(supplier, "select public.create_organization('Fábrica X')");
  await scalar(outsider, "select public.create_organization('Loja W')");
  const inv = await scalar<string>(
    seller,
    "select public.invite_member($1, 'membro@example.com', 'member')",
    [sellerOrg],
  );
  await scalar(sellerMember, 'select public.accept_invitation($1)', [inv]);

  connection = await scalar<string>(
    seller,
    "select public.create_connection($1, 'shopify', 'Minha loja', 'Loja.MyShopify.com', $2)",
    [sellerOrg, SECRET],
  );
});

afterEach(async () => {
  await db.close();
});

const CIPHER = 'v1.aGVsbG8taXYtMTI=.Y2lwaGVydGV4dC1kYS1jcmVkZW5jaWFs';

const store = (
  userId: string | null,
  conn = connection,
  config: unknown = { location_id: '123' },
) =>
  scalar(userId, 'select public.store_connection_credentials($1, $2, 1::smallint, $3)', [
    conn,
    CIPHER,
    JSON.stringify(config),
  ]);

const status = (userId: string, conn = connection) =>
  rows<{ configured: boolean }>(
    userId,
    'select configured from public.connection_credentials_status($1)',
    [conn],
  );

describe('credenciais: armazenamento', () => {
  it('guarda o texto cifrado e informa só se está configurado', async () => {
    expect(await status(seller)).toEqual([{ configured: false }]);
    await store(seller);
    expect(await status(seller)).toEqual([{ configured: true }]);
    const stored = await service<string>('select ciphertext from public.integration_credentials');
    expect(stored).toBe(CIPHER);
  });

  it('nenhum papel da API lê credenciais, nem o dono', async () => {
    await store(seller);
    await expect(scalar(seller, 'select 1 from public.integration_credentials')).rejects.toThrow(
      /permission denied/,
    );
    await expect(scalar(null, 'select 1 from public.integration_credentials')).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      scalar(seller, 'select ciphertext from public.integration_credentials'),
    ).rejects.toThrow(/permission denied/);
  });

  it('substitui as credenciais ao guardar de novo', async () => {
    await store(seller, connection, { location_id: '1' });
    await store(seller, connection, { location_id: '2' });
    const rowsNow = await db.query<{ config: { location_id: string } }>(
      'select config from public.integration_credentials',
    );
    expect(rowsNow.rows).toEqual([{ config: { location_id: '2' } }]);
  });

  it('só owner/admin da conexão guardam ou consultam', async () => {
    for (const user of [sellerMember, outsider, supplier]) {
      await expect(store(user)).rejects.toThrow(/integrations.not_found/);
      await expect(status(user)).rejects.toThrow(/integrations.not_found/);
    }
    await expect(store(null)).rejects.toThrow(/permission denied/);
  });

  it('rejeita texto cifrado curto demais e config que não é objeto', async () => {
    await expect(
      scalar(seller, "select public.store_connection_credentials($1, 'x', 1::smallint, '{}')", [
        connection,
      ]),
    ).rejects.toThrow(/check/);
    await expect(store(seller, connection, ['a'])).rejects.toThrow(/check/);
  });

  it('desconectar apaga as credenciais e impede guardar de novo', async () => {
    await store(seller);
    await scalar(seller, "select public.set_connection_status($1, 'disconnected')", [connection]);
    expect(await service<number>('select count(*) from public.integration_credentials')).toBe(0);
    await expect(store(seller)).rejects.toThrow(/integrations.disconnected/);
  });

  it('o worker (service role) lê o cifrado, e só ele', async () => {
    await store(seller);
    const viaService = await service<string>(
      'select connection_id::text from public.integration_credentials',
    );
    expect(viaService).toBe(connection);
  });
});
