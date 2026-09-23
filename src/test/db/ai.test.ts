// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let seller: string;
let sellerMember: string;
let outsider: string;
let sellerOrg: string;
let outsiderOrg: string;
let product: string;
let outsiderProduct: string;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

interface Begin {
  usage_id: string;
  remaining: number;
  product: {
    name: string;
    brand: string | null;
    sku: string;
    description: string | null;
    variants: Record<string, string>[];
  };
}

const begin = (userId: string | null, org = sellerOrg, prod = product) =>
  scalar<Begin>(userId, 'select public.ai_begin_description($1, $2)', [org, prod]);

const finish = (userId: string | null, usage: string, ok = true, input = 120, output = 80) =>
  scalar(userId, 'select public.ai_finish($1, $2, $3, $4)', [usage, ok, input, output]);

const usageToday = () =>
  scalar<{ used: number; daily_limit: number }>(
    seller,
    'select row_to_json(t) from public.ai_usage_today($1) t',
    [sellerOrg],
  );

beforeEach(async () => {
  db = await createTestDatabase();
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  sellerMember = await signUpUser(db, 'membro@example.com', { full_name: 'Membro' });
  outsider = await signUpUser(db, 'out@example.com', { full_name: 'Outra Loja' });
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  outsiderOrg = await scalar(outsider, "select public.create_organization('Loja W')");
  const inv = await scalar<string>(
    seller,
    "select public.invite_member($1, 'membro@example.com', 'member')",
    [sellerOrg],
  );
  await scalar(sellerMember, 'select public.accept_invitation($1)', [inv]);

  product = await scalar<string>(
    seller,
    `insert into public.products (organization_id, sku, name, brand, description, price_cents, status)
     values ($1, 'CAM', 'Camiseta Básica', 'Marca X', 'Algodão', 4990, 'active') returning id`,
    [sellerOrg],
  );
  await scalar(
    seller,
    `insert into public.product_variants (organization_id, product_id, sku, attributes)
     values ($1, $2, 'CAM-P', '{"Tamanho":"P"}')`,
    [sellerOrg, product],
  );
  outsiderProduct = await scalar<string>(
    outsider,
    `insert into public.products (organization_id, sku, name, price_cents, status)
     values ($1, 'SEGREDO', 'Produto Secreto', 100, 'active') returning id`,
    [outsiderOrg],
  );
});

afterEach(async () => {
  await db.close();
});

describe('IA: autorização', () => {
  it('só owner/admin geram, e só para produtos da própria organização', async () => {
    await expect(begin(sellerMember)).rejects.toThrow(/org.forbidden/);
    await expect(begin(outsider)).rejects.toThrow(/org.forbidden/);
    await expect(begin(null)).rejects.toThrow(/permission denied/);
    // Produto de outra organização, mesmo com org própria informada.
    await expect(begin(seller, sellerOrg, outsiderProduct)).rejects.toThrow(/ai.product_not_found/);
    await expect(begin(outsider, outsiderOrg, product)).rejects.toThrow(/ai.product_not_found/);
    await expect(begin(seller, '00000000-0000-4000-8000-000000000000')).rejects.toThrow(
      /org.forbidden/,
    );
  });

  it('entrega só os dados do produto necessários ao prompt', async () => {
    const res = await begin(seller);
    expect(res.product).toMatchObject({
      name: 'Camiseta Básica',
      brand: 'Marca X',
      sku: 'CAM',
      description: 'Algodão',
      variants: [{ Tamanho: 'P' }],
    });
    // Sem preço, custo nem ids internos.
    expect(Object.keys(res.product).sort()).toEqual(
      ['brand', 'description', 'name', 'sku', 'variants', 'weight_grams'].sort(),
    );
  });

  it('não expõe o log de uso pela API e o uso do dia é só de owner/admin', async () => {
    await begin(seller);
    await expect(scalar(seller, 'select 1 from public.ai_usage')).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      scalar(sellerMember, 'select public.ai_usage_today($1)', [sellerOrg]),
    ).rejects.toThrow(/org.forbidden/);
  });
});

describe('IA: cota', () => {
  it('conta gerações concluídas e em andamento; falha devolve a cota', async () => {
    const a = await begin(seller);
    expect(a.remaining).toBe(49);
    expect(await usageToday()).toEqual({ used: 1, daily_limit: 50 });

    await finish(seller, a.usage_id, false);
    expect(await usageToday()).toEqual({ used: 0, daily_limit: 50 });

    const b = await begin(seller);
    await finish(seller, b.usage_id, true, 200, 90);
    expect(await usageToday()).toEqual({ used: 1, daily_limit: 50 });
    const row = await db.query<{ status: string; input_tokens: number; output_tokens: number }>(
      'select status, input_tokens, output_tokens from public.ai_usage where id = $1',
      [b.usage_id],
    );
    expect(row.rows[0]).toEqual({ status: 'done', input_tokens: 200, output_tokens: 90 });
  });

  it('bloqueia ao atingir o limite diário e libera depois de uma falha', async () => {
    await db.query(
      `insert into public.ai_usage (organization_id, feature, status)
       select $1, 'product_description', 'done' from generate_series(1, 50)`,
      [sellerOrg],
    );
    await expect(begin(seller)).rejects.toThrow(/ai.quota_exceeded/);
    // A cota é por organização: outra loja não é afetada.
    await expect(begin(outsider, outsiderOrg, outsiderProduct)).resolves.toBeTruthy();

    await db.query(
      "update public.ai_usage set status = 'failed' where id = (select id from public.ai_usage where organization_id = $1 limit 1)",
      [sellerOrg],
    );
    await expect(begin(seller)).resolves.toBeTruthy();
  });

  it('reserva presa expira depois de 5 minutos e usos de ontem não contam', async () => {
    await begin(seller);
    expect((await usageToday()).used).toBe(1);
    await db.query("update public.ai_usage set created_at = now() - interval '6 minutes'");
    expect((await usageToday()).used).toBe(0);

    const done = await begin(seller);
    await finish(seller, done.usage_id);
    await db.query("update public.ai_usage set created_at = now() - interval '2 days'");
    expect((await usageToday()).used).toBe(0);
  });

  it('só quem abriu fecha a reserva, uma única vez', async () => {
    const a = await begin(seller);
    await expect(finish(sellerMember, a.usage_id)).rejects.toThrow(/ai.usage_not_found/);
    await expect(finish(outsider, a.usage_id)).rejects.toThrow(/ai.usage_not_found/);
    await finish(seller, a.usage_id);
    await expect(finish(seller, a.usage_id)).rejects.toThrow(/ai.usage_not_found/);
  });
});
