// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let admin: string;
let sellerOrg: string;

async function scalar<T>(
  userId: string | null,
  sql: string,
  params: unknown[] = [],
  aal: 'aal1' | 'aal2' = 'aal2',
): Promise<T> {
  return asUser(
    db,
    userId,
    async (tx) => {
      const res = await tx.query<Record<string, T>>(sql, params);
      return Object.values(res.rows[0] ?? {})[0] as T;
    },
    aal,
  );
}

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
  admin = await signUpUser(db, 'staff@example.com', { full_name: 'Equipe' });
  await db.query("update public.profiles set role = 'admin' where id = $1", [admin]);
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
});

afterEach(async () => {
  await db.close();
});

describe('rate limiting', () => {
  it('convites: até 50 por hora por organização', async () => {
    for (let i = 0; i < 50; i++) {
      await scalar(seller, "select public.invite_member($1, $2, 'member')", [
        sellerOrg,
        `pessoa${i}@example.com`,
      ]);
    }
    await expect(
      scalar(seller, "select public.invite_member($1, 'mais@example.com', 'member')", [sellerOrg]),
    ).rejects.toThrow(/rate_limited/);
  });

  it('links de divulgação: até 50 por hora por loja', async () => {
    for (let i = 0; i < 50; i++) {
      await scalar(seller, 'select public.create_affiliate_link($1, $2, null, null)', [
        sellerOrg,
        `Link ${i}`,
      ]);
    }
    await expect(
      scalar(seller, "select public.create_affiliate_link($1, 'Mais um', null, null)", [sellerOrg]),
    ).rejects.toThrow(/rate_limited/);
  });

  it('contador para a Edge Function: só service role, por assunto e janela', async () => {
    const hit = () =>
      service<boolean>("select public.rate_limit_hit('checkout.pay', 'ip-a', 3, 600)");
    expect([await hit(), await hit(), await hit(), await hit()]).toEqual([true, true, true, false]);
    expect(await service("select public.rate_limit_hit('checkout.pay', 'ip-b', 3, 600)")).toBe(
      true,
    );
    await expect(
      service("select public.rate_limit_hit('Bucket Inválido', 'x', 3, 600)"),
    ).rejects.toThrow(/rate_limit.invalid/);
    await expect(
      scalar(seller, "select public.rate_limit_hit('checkout.pay', 'ip-a', 3, 600)"),
    ).rejects.toThrow(/permission denied/);
    await expect(scalar(seller, 'select count(*) from private.rate_limits')).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('MFA da equipe', () => {
  it('sem segundo fator (aal1) a equipe não age nem lê dados da administração', async () => {
    await expect(scalar(admin, 'select public.admin_stats()', [], 'aal1')).rejects.toThrow(
      /admin.forbidden/,
    );
    await expect(
      scalar(admin, 'select public.admin_save_referral_settings(true, 500, 0, 90)', [], 'aal1'),
    ).rejects.toThrow(/admin.forbidden/);
    // Policies da equipe também exigem aal2: organização alheia fica invisível.
    expect(
      await scalar(admin, 'select count(*)::int from public.affiliate_links', [], 'aal1'),
    ).toBe(0);

    expect(await scalar(admin, 'select public.admin_stats()')).toBeTruthy();
    await scalar(admin, 'select public.admin_save_referral_settings(true, 500, 0, 90)');
  });

  it('aal2 não transforma conta comum em equipe', async () => {
    await expect(scalar(seller, 'select public.admin_stats()')).rejects.toThrow(/admin.forbidden/);
  });
});
