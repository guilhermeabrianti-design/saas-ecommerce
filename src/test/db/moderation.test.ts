// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let admin: string;
let seller: string;
let supplier: string;
let supplierMember: string;
let sellerOrg: string;
let supplierOrg: string;
let product: string;
let listing: string;
let imagePath: string;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

async function rows<T>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, userId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

const reviewSupplier = (approve: boolean, reason: string | null = null, user = admin) =>
  scalar(user, 'select public.admin_review_supplier($1, $2, $3)', [supplierOrg, approve, reason]);

const moderate = (action: string, reason: string | null = null, user = admin, id = listing) =>
  scalar(user, 'select public.admin_moderate_listing($1, $2, $3)', [id, action, reason]);

const searchCount = async () =>
  (await rows(seller, 'select listing_id from public.search_catalog(null, 24, 0)')).length;

const detail = () => scalar(seller, 'select public.get_catalog_listing($1)', [listing]);

const sellerSeesImage = async () =>
  (await rows(seller, 'select name from storage.objects where name = $1', [imagePath])).length;

const status = () =>
  scalar<string>(supplier, 'select moderation_status from public.catalog_listings where id = $1', [
    listing,
  ]);

beforeEach(async () => {
  db = await createTestDatabase();
  admin = await signUpUser(db, 'staff@example.com', { full_name: 'Equipe' });
  await db.query("update public.profiles set role = 'admin' where id = $1", [admin]);
  seller = await signUpUser(db, 'vend@example.com', { full_name: 'Vendedor' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Dona Fábrica',
    account_type: 'supplier',
  });
  supplierMember = await signUpUser(db, 'membro@example.com', {
    full_name: 'Membro',
    account_type: 'supplier',
  });
  sellerOrg = await scalar(seller, "select public.create_organization('Loja V')");
  supplierOrg = await scalar(supplier, "select public.create_organization('Fábrica X')");
  const inv = await scalar<string>(
    supplier,
    "select public.invite_member($1, 'membro@example.com', 'admin')",
    [supplierOrg],
  );
  await scalar(supplierMember, 'select public.accept_invitation($1)', [inv]);

  product = await scalar<string>(
    supplier,
    "insert into public.products (organization_id, sku, name, description, price_cents, status) values ($1, 'SW', 'Smartwatch X', 'Relógio', 8990, 'active') returning id",
    [supplierOrg],
  );
  listing = await scalar<string>(
    supplier,
    `insert into public.catalog_listings (organization_id, product_id, wholesale_price_cents, is_published)
     values ($1, $2, 4500, true) returning id`,
    [supplierOrg, product],
  );
  imagePath = `${supplierOrg}/${product}/capa.webp`;
  await db.query(
    "insert into storage.objects (bucket_id, name, owner) values ('product-images', $1, $2)",
    [imagePath, supplier],
  );
  // Fase 35: tudo nasce aprovado. Os testes de fila partem de itens em (nova) análise.
  await db.query("update public.organizations set approval_status = 'pending' where id = $1", [
    supplierOrg,
  ]);
  await db.query("update public.catalog_listings set moderation_status = 'pending' where id = $1", [
    listing,
  ]);
});

afterEach(async () => {
  await db.close();
});

describe('moderação: estado inicial e visibilidade', () => {
  it('fornecedor e anúncio novos já nascem aprovados e aparecem na hora (Fase 35)', async () => {
    const owner = await signUpUser(db, 'nova@example.com', {
      full_name: 'Nova',
      account_type: 'supplier',
    });
    const org = await scalar<string>(owner, "select public.create_organization('Nova Fábrica')");
    const p = await scalar<string>(
      owner,
      "insert into public.products (organization_id, sku, name, price_cents, status) values ($1, 'N1', 'Novo', 1000, 'active') returning id",
      [org],
    );
    const l = await scalar<string>(
      owner,
      `insert into public.catalog_listings (organization_id, product_id, wholesale_price_cents, is_published)
       values ($1, $2, 500, true) returning id`,
      [org, p],
    );
    expect(
      await scalar(owner, 'select approval_status from public.organizations where id = $1', [org]),
    ).toBe('approved');
    expect(
      await scalar(owner, 'select moderation_status from public.catalog_listings where id = $1', [
        l,
      ]),
    ).toBe('approved');
    expect(await rows(seller, 'select listing_id from public.search_catalog(null, 24, 0)')).toEqual(
      [{ listing_id: l }],
    );
  });

  it('a equipe ainda reprova fornecedor já aprovado (some do catálogo)', async () => {
    await reviewSupplier(true);
    await moderate('approve');
    expect(await searchCount()).toBe(1);
    await reviewSupplier(false, 'Fraude confirmada');
    expect(await searchCount()).toBe(0);
  });

  it('só aparece para vendedores com fornecedor E anúncio aprovados', async () => {
    const hidden = async () => {
      expect(await searchCount()).toBe(0);
      await expect(detail()).rejects.toThrow(/catalog.listing_not_found/);
      await expect(
        scalar(seller, "select public.import_catalog_listing($1, $2, '')", [sellerOrg, listing]),
      ).rejects.toThrow(/catalog.listing_not_found/);
      expect(await sellerSeesImage()).toBe(0);
    };
    await hidden();
    await moderate('approve');
    await hidden(); // fornecedor ainda pendente
    await reviewSupplier(true);
    expect(await searchCount()).toBe(1);
    await detail();
    expect(await sellerSeesImage()).toBe(1);

    await moderate('block', 'Produto proibido');
    await hidden();
  });

  it('fornecedor não altera a própria aprovação nem a moderação', async () => {
    await expect(
      rows(supplier, "update public.organizations set approval_status = 'approved' where id = $1", [
        supplierOrg,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      rows(
        supplier,
        "update public.catalog_listings set moderation_status = 'approved' where id = $1",
        [listing],
      ),
    ).rejects.toThrow(/permission denied/);
    // Ao criar, o valor informado é ignorado: o banco decide.
    await expect(
      rows(
        supplier,
        `insert into public.catalog_listings (organization_id, product_id, wholesale_price_cents, moderation_status)
         values ($1, $2, 100, 'approved')`,
        [supplierOrg, product],
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('moderação: fornecedores', () => {
  it('reprovar exige motivo; o fornecedor vê o motivo e pede nova análise', async () => {
    await expect(reviewSupplier(false)).rejects.toThrow(/moderation.reason_required/);
    await reviewSupplier(false, 'CNPJ não confere');
    expect(
      await scalar(supplier, 'select approval_reason from public.organizations where id = $1', [
        supplierOrg,
      ]),
    ).toBe('CNPJ não confere');
    await expect(reviewSupplier(false, 'de novo')).rejects.toThrow(/moderation.no_change/);

    // Só o proprietário pede nova análise, e só quando reprovado.
    await expect(
      scalar(supplierMember, 'select public.request_supplier_review($1)', [supplierOrg]),
    ).rejects.toThrow(/moderation.not_found/);
    await expect(
      scalar(seller, 'select public.request_supplier_review($1)', [supplierOrg]),
    ).rejects.toThrow(/moderation.not_found/);
    await scalar(supplier, 'select public.request_supplier_review($1)', [supplierOrg]);
    await expect(
      scalar(supplier, 'select public.request_supplier_review($1)', [supplierOrg]),
    ).rejects.toThrow(/moderation.no_change/);

    await reviewSupplier(true);
    expect(
      await scalar(
        supplier,
        'select approval_reason is null and approval_reviewed_at is not null from public.organizations where id = $1',
        [supplierOrg],
      ),
    ).toBe(true);
    await expect(reviewSupplier(true)).rejects.toThrow(/moderation.no_change/);
  });

  it('fila de fornecedores para a equipe, com contato do responsável', async () => {
    const queue = await rows<{ name: string; owner_email: string; listings: number }>(
      admin,
      "select * from public.admin_supplier_reviews('pending', 10, 0)",
    );
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ name: 'Fábrica X', owner_email: 'forn@example.com' });
    expect(Number(queue[0]!.listings)).toBe(1);
    await reviewSupplier(true);
    expect(
      await rows(admin, "select * from public.admin_supplier_reviews('pending', 10, 0)"),
    ).toEqual([]);
    expect(
      await rows(admin, 'select * from public.admin_supplier_reviews(null, 10, 0)'),
    ).toHaveLength(1);
  });
});

describe('moderação: anúncios', () => {
  it('reprovar → corrigir e reenviar → aprovar; bloqueado não reenvia', async () => {
    await expect(moderate('reject')).rejects.toThrow(/moderation.reason_required/);
    await moderate('reject', 'Fotos com marca d’água');
    expect(
      await scalar(
        supplier,
        'select moderation_reason from public.catalog_listings where id = $1',
        [listing],
      ),
    ).toBe('Fotos com marca d’água');
    await expect(
      scalar(seller, 'select public.resubmit_catalog_listing($1)', [listing]),
    ).rejects.toThrow(/moderation.not_found/);
    await scalar(supplierMember, 'select public.resubmit_catalog_listing($1)', [listing]);
    expect(await status()).toBe('pending');
    await expect(
      scalar(supplier, 'select public.resubmit_catalog_listing($1)', [listing]),
    ).rejects.toThrow(/moderation.no_change/);

    await moderate('approve');
    await expect(moderate('approve')).rejects.toThrow(/moderation.no_change/);
    await moderate('block', 'Réplica de marca');
    await expect(moderate('reject', 'x x x')).rejects.toThrow(/moderation.no_change/);
    await expect(
      scalar(supplier, 'select public.resubmit_catalog_listing($1)', [listing]),
    ).rejects.toThrow(/moderation.blocked/);
    await moderate('approve');
    expect(await status()).toBe('approved');
    await expect(moderate('publicar')).rejects.toThrow(/moderation.invalid/);
  });

  it('fila com dados e imagens; a equipe vê as imagens do anúncio', async () => {
    const queue = await rows<{
      product_name: string;
      image_paths: string[];
      supplier_approval: string;
    }>(admin, "select * from public.admin_moderation_listings('pending', null, 20, 0)");
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ product_name: 'Smartwatch X', supplier_approval: 'pending' });
    expect(
      await rows(admin, "select * from public.admin_moderation_listings('pending', 'nada', 20, 0)"),
    ).toEqual([]);
    expect(
      (await rows(admin, "select * from public.admin_moderation_listings(null, 'fábrica', 20, 0)"))
        .length,
    ).toBe(1);
    expect(
      (await rows(admin, 'select name from storage.objects where name = $1', [imagePath])).length,
    ).toBe(1);
  });

  it('a equipe corrige nome, descrição e categoria, com auditoria', async () => {
    const cat = await scalar<string>(
      admin,
      "select public.admin_save_category(null, 'Relógios', null)",
    );
    await scalar(admin, 'select public.admin_update_listing_content($1, $2, $3, $4)', [
      listing,
      'Smartwatch X Pro',
      'Relógio inteligente',
      cat,
    ]);
    expect(
      await scalar(supplier, 'select name from public.products where id = $1', [product]),
    ).toBe('Smartwatch X Pro');
    await expect(
      scalar(admin, 'select public.admin_update_listing_content($1, $2, $3, $4)', [
        listing,
        'Smartwatch X Pro',
        'Relógio inteligente',
        cat,
      ]),
    ).rejects.toThrow(/moderation.no_change/);
    await expect(
      scalar(admin, 'select public.admin_update_listing_content($1, $2, $3, null)', [
        listing,
        'X',
        '',
      ]),
    ).rejects.toThrow(/moderation.invalid/);

    await moderate('reject', 'Descrição incompleta');
    const audit = await rows<{ action: string; reason: string }>(
      admin,
      'select action, reason from public.admin_audit_entries(10, 0)',
    );
    expect(audit.map((a) => a.action)).toEqual([
      'listing.rejected',
      'listing.edited',
      'category.saved',
    ]);
    expect(audit[0]!.reason).toBe('Descrição incompleta');
    expect(audit[1]!.reason).toBe('Smartwatch X → Smartwatch X Pro');
  });
});

describe('moderação: acesso', () => {
  it('só a equipe usa as RPCs de moderação', async () => {
    for (const user of [seller, supplier]) {
      await expect(reviewSupplier(true, null, user)).rejects.toThrow(/admin.forbidden/);
      await expect(moderate('approve', null, user)).rejects.toThrow(/admin.forbidden/);
      await expect(
        rows(user, 'select * from public.admin_moderation_listings(null, null, 20, 0)'),
      ).rejects.toThrow(/admin.forbidden/);
      await expect(
        rows(user, 'select * from public.admin_supplier_reviews(null, 20, 0)'),
      ).rejects.toThrow(/admin.forbidden/);
      await expect(
        scalar(user, "select public.admin_update_listing_content($1, 'Nome', '', null)", [listing]),
      ).rejects.toThrow(/admin.forbidden/);
    }
  });

  it('indicadores mostram as filas pendentes', async () => {
    const stats = await scalar<Record<string, number>>(admin, 'select public.admin_stats()');
    expect(stats).toMatchObject({ pending_suppliers: 1, pending_listings: 1 });
  });
});
