// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let owner: string;
let member: string;
let outsider: string;
let org: string;
let otherOrg: string;
let product: string;
let otherProduct: string;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

const newProduct = (userId: string, orgId: string, sku: string) =>
  scalar<string>(
    userId,
    "insert into public.products (organization_id, sku, name, price_cents) values ($1, $2, 'Camiseta', 4990) returning id",
    [orgId, sku],
  );

const newVariant = (userId: string, sku: string, attrs: object, productId = product, orgId = org) =>
  scalar<string>(
    userId,
    'insert into public.product_variants (organization_id, product_id, sku, attributes) values ($1, $2, $3, $4) returning id',
    [orgId, productId, sku, JSON.stringify(attrs)],
  );

const imagePath = (orgId: string, productId: string, file = 'a1b2c3') =>
  `${orgId}/${productId}/${file}.webp`;

const newImage = (userId: string, path: string, productId = product, orgId = org) =>
  scalar<string>(
    userId,
    'insert into public.product_images (organization_id, product_id, storage_path) values ($1, $2, $3) returning id',
    [orgId, productId, path],
  );

const upload = (userId: string, name: string) =>
  scalar(userId, "insert into storage.objects (bucket_id, name) values ('product-images', $1)", [
    name,
  ]);

beforeEach(async () => {
  db = await createTestDatabase();
  owner = await signUpUser(db, 'owner@example.com', { full_name: 'Owner' });
  member = await signUpUser(db, 'member@example.com', { full_name: 'Member' });
  outsider = await signUpUser(db, 'out@example.com', { full_name: 'Outsider' });
  org = await scalar(owner, "select public.create_organization('Loja Owner')");
  otherOrg = await scalar(outsider, "select public.create_organization('Loja Outsider')");
  const inv = await scalar<string>(
    owner,
    "select public.invite_member($1, 'member@example.com', 'member')",
    [org],
  );
  await scalar(member, 'select public.accept_invitation($1)', [inv]);
  product = await newProduct(owner, org, 'CAM');
  otherProduct = await newProduct(outsider, otherOrg, 'OUT');
});

afterEach(async () => {
  await db.close();
});

describe('product_variants', () => {
  it('owner cria variações; membro lê; outra organização não vê', async () => {
    await newVariant(owner, 'CAM-AZ-M', { Cor: 'Azul', Tamanho: 'M' });
    const read = (u: string) =>
      asUser(db, u, async (tx) => (await tx.query('select sku from public.product_variants')).rows);
    expect(await read(member)).toEqual([{ sku: 'CAM-AZ-M' }]);
    expect(await read(outsider)).toEqual([]);
    await expect(newVariant(member, 'CAM-AZ-G', { Cor: 'Azul' })).rejects.toThrow(
      /row-level security/,
    );
  });

  it('variação precisa pertencer à organização do produto (FK composta)', async () => {
    // Outsider tries to hang a variant on our product under their own organization.
    await expect(
      newVariant(outsider, 'EVIL-1', { Cor: 'Azul' }, product, otherOrg),
    ).rejects.toThrow(/foreign key/);
    await expect(newVariant(owner, 'X-1', { Cor: 'Azul' }, otherProduct, org)).rejects.toThrow(
      /foreign key/,
    );
  });

  it('SKU é único na organização entre produtos e variações', async () => {
    await expect(newVariant(owner, 'cam', { Cor: 'Azul' })).rejects.toThrow(/products.sku_taken/);
    await newVariant(owner, 'CAM-AZ', { Cor: 'Azul' });
    await expect(newProduct(owner, org, 'cam-az')).rejects.toThrow(/products.sku_taken/);
    await expect(newVariant(owner, 'CAM-AZ', { Cor: 'Verde' })).rejects.toThrow(
      /products.sku_taken/,
    );
    // Other organizations may reuse it.
    await expect(
      newVariant(outsider, 'CAM-AZ', { Cor: 'Azul' }, otherProduct, otherOrg),
    ).resolves.toBeTruthy();
  });

  it('não revela SKUs de outra organização (trigger roda antes da RLS)', async () => {
    // 'CAM' exists in `org`. An outsider probing it must get the RLS refusal,
    // exactly as for a SKU that does not exist — never "sku_taken".
    for (const sku of ['CAM', 'NAO-EXISTE']) {
      await expect(newProduct(outsider, org, sku)).rejects.toThrow(/row-level security/);
    }
  });

  it('valida atributos e não repete a combinação no produto', async () => {
    for (const bad of [
      {},
      { Cor: 'Azul', Tamanho: 'M', Tecido: 'Algodão', Gola: 'V' },
      { Cor: 1 },
      { ' Cor': 'Azul' },
      { Cor: '' },
      ['Azul'],
    ]) {
      await expect(newVariant(owner, 'V-X', bad)).rejects.toThrow(/check constraint/);
    }
    await newVariant(owner, 'V-1', { Cor: 'Azul', Tamanho: 'M' });
    await expect(newVariant(owner, 'V-2', { Tamanho: 'M', Cor: 'Azul' })).rejects.toThrow(
      /duplicate key/,
    );
  });

  it('exclusão só enquanto o produto é rascunho', async () => {
    const v = await newVariant(owner, 'V-1', { Cor: 'Azul' });
    await scalar(owner, "update public.products set status = 'active' where id = $1", [product]);
    const del = () =>
      asUser(
        db,
        owner,
        async (tx) =>
          (await tx.query('delete from public.product_variants where id = $1', [v])).affectedRows,
      );
    expect(await del()).toBe(0);
    await scalar(owner, "update public.products set status = 'draft' where id = $1", [product]);
    expect(await del()).toBe(1);
  });

  it('não move variação de produto/organização', async () => {
    const v = await newVariant(owner, 'V-1', { Cor: 'Azul' });
    await expect(
      scalar(owner, 'update public.product_variants set product_id = $1 where id = $2', [
        otherProduct,
        v,
      ]),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('product_images', () => {
  it('posição automática, limite de 10 e caminho preso ao produto', async () => {
    const first = await newImage(owner, imagePath(org, product, 'img0'));
    const second = await newImage(owner, imagePath(org, product, 'img1'));
    const pos = await db.query<{ id: string; position: number }>(
      'select id, position from public.product_images order by position',
    );
    expect(pos.rows).toEqual([
      { id: first, position: 0 },
      { id: second, position: 1 },
    ]);
    for (let i = 2; i < 10; i++) await newImage(owner, imagePath(org, product, `img${i}`));
    await expect(newImage(owner, imagePath(org, product, 'img10'))).rejects.toThrow(
      /products.image_limit/,
    );
  });

  it('não revela a contagem de imagens de outra organização', async () => {
    for (let i = 0; i < 10; i++) await newImage(owner, imagePath(org, product, `img${i}`));
    await expect(newImage(outsider, imagePath(org, product, 'probe'))).rejects.toThrow(
      /row-level security/,
    );
  });

  it('rejeita caminho fora da pasta do produto', async () => {
    const other = await newProduct(owner, org, 'OUTRO');
    await expect(newImage(owner, imagePath(org, other))).rejects.toThrow(/check constraint/);
    await expect(newImage(owner, `${org}/${product}/../x.webp`)).rejects.toThrow(
      /check constraint/,
    );
    await expect(
      newImage(owner, imagePath(org, product, 'x').replace('.webp', '.svg')),
    ).rejects.toThrow(/check constraint/);
  });

  it('membro lê, mas não cria; outra organização não vê', async () => {
    await newImage(owner, imagePath(org, product));
    await expect(newImage(member, imagePath(org, product, 'm'))).rejects.toThrow(
      /row-level security/,
    );
    const seen = await asUser(
      db,
      outsider,
      async (tx) => (await tx.query('select 1 from public.product_images')).rows,
    );
    expect(seen).toEqual([]);
  });

  it('reordena com a RPC, validando a lista', async () => {
    const a = await newImage(owner, imagePath(org, product, 'a'));
    const b = await newImage(owner, imagePath(org, product, 'b'));
    await scalar(owner, 'select public.set_product_image_order($1, $2)', [product, [b, a]]);
    const res = await db.query<{ id: string }>(
      'select id from public.product_images order by position',
    );
    expect(res.rows.map((r) => r.id)).toEqual([b, a]);

    await expect(
      scalar(owner, 'select public.set_product_image_order($1, $2)', [product, [a, a]]),
    ).rejects.toThrow(/products.invalid_image_order/);
    await expect(
      scalar(owner, 'select public.set_product_image_order($1, $2)', [product, [a]]),
    ).rejects.toThrow(/products.invalid_image_order/);
    await expect(
      scalar(member, 'select public.set_product_image_order($1, $2)', [product, [a, b]]),
    ).rejects.toThrow(/org.forbidden/);
    await expect(
      scalar(outsider, 'select public.set_product_image_order($1, $2)', [product, [a, b]]),
    ).rejects.toThrow(/org.forbidden/);
  });
});

describe('storage: bucket product-images', () => {
  it('bucket é privado e restrito a imagens de até 5 MB', async () => {
    const res = await db.query("select * from storage.buckets where id = 'product-images'");
    expect(res.rows[0]).toMatchObject({
      public: false,
      file_size_limit: 5242880,
      allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'],
    });
  });

  it('owner envia para a pasta do produto; membro e outsider não', async () => {
    await upload(owner, imagePath(org, product));
    await expect(upload(member, imagePath(org, product, 'm'))).rejects.toThrow(
      /row-level security/,
    );
    await expect(upload(outsider, imagePath(org, product, 'o'))).rejects.toThrow(
      /row-level security/,
    );
  });

  it('não envia para caminho malformado ou de produto de outra organização', async () => {
    await expect(upload(owner, `${org}/qualquer.webp`)).rejects.toThrow(/row-level security/);
    await expect(upload(owner, imagePath(org, otherProduct))).rejects.toThrow(/row-level security/);
    await expect(upload(owner, imagePath(otherOrg, otherProduct))).rejects.toThrow(
      /row-level security/,
    );
  });

  it('membros leem arquivos da organização; outsider e anon não', async () => {
    await upload(owner, imagePath(org, product));
    const read = (u: string | null) =>
      asUser(db, u, async (tx) => (await tx.query('select name from storage.objects')).rows.length);
    expect(await read(member)).toBe(1);
    expect(await read(outsider)).toBe(0);
    expect(await read(null)).toBe(0);
  });

  it('só owner/admin excluem arquivos', async () => {
    await upload(owner, imagePath(org, product));
    const del = (u: string) =>
      asUser(
        db,
        u,
        async (tx) =>
          (await tx.query("delete from storage.objects where bucket_id = 'product-images'"))
            .affectedRows,
      );
    expect(await del(member)).toBe(0);
    expect(await del(outsider)).toBe(0);
    expect(await del(owner)).toBe(1);
  });
});
