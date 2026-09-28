// @vitest-environment node
import {
  PublishError,
  buildShopifyProductSet,
  buildWooProduct,
  buildWooVariation,
  centsToDecimal,
  optionValues,
  publishShopify,
  publishWoo,
  setWooStatus,
  toHtml,
  type PublishPayload,
} from '../../supabase/functions/_shared/integrations/publish';

const variable: PublishPayload = {
  title: 'Camiseta',
  description: 'Algodão <macio>\n\nLava fácil',
  external_id: null,
  target_status: 'active',
  option_names: ['Cor'],
  variants: [
    {
      inventory_item_id: 'a',
      sku: 'FX-AZ',
      price_cents: 6990,
      available: 40,
      options: { Cor: 'Azul' },
    },
    {
      inventory_item_id: 'b',
      sku: 'FX-VM',
      price_cents: 7990,
      available: 0,
      options: { Cor: 'Vermelho' },
    },
  ],
};

const simple: PublishPayload = {
  ...variable,
  option_names: [],
  variants: [
    { inventory_item_id: 'c', sku: 'CANECA', price_cents: 3500, available: 7, options: {} },
  ],
};

type Call = { url: string; init: RequestInit };

/** fetch simulado: responde na ordem, guardando as chamadas. */
function fakeFetch(responses: { status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const r = responses.shift() ?? { body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { fn, calls, body: (i: number) => JSON.parse(String(calls[i]!.init.body)) };
}

describe('conversões', () => {
  it('valores, HTML seguro e opções', () => {
    expect(centsToDecimal(6990)).toBe('69.90');
    expect(centsToDecimal(5)).toBe('0.05');
    expect(toHtml('Algodão <macio>\n\nLava\nfácil')).toBe(
      '<p>Algodão &lt;macio&gt;</p><p>Lava<br>fácil</p>',
    );
    expect(toHtml(null)).toBe('');
    expect(optionValues(variable)).toEqual([{ name: 'Cor', values: ['Azul', 'Vermelho'] }]);
  });
});

describe('Shopify', () => {
  it('monta o productSet: opções, variações com SKU/preço, status e fotos só na criação', () => {
    const input = buildShopifyProductSet(variable, {
      existingVariantIds: new Map(),
      imageUrls: ['https://x.supabase.co/storage/a.jpg'],
    });
    expect(input).toMatchObject({
      title: 'Camiseta',
      status: 'ACTIVE',
      productOptions: [{ name: 'Cor', values: [{ name: 'Azul' }, { name: 'Vermelho' }] }],
      files: [{ originalSource: 'https://x.supabase.co/storage/a.jpg', contentType: 'IMAGE' }],
    });
    expect((input.variants as unknown[])[1]).toEqual({
      optionValues: [{ optionName: 'Cor', name: 'Vermelho' }],
      price: '79.90',
      inventoryItem: { sku: 'FX-VM', tracked: true },
    });

    const update = buildShopifyProductSet(
      { ...simple, external_id: '123', target_status: 'paused' },
      {
        existingVariantIds: new Map([['CANECA', 'gid://shopify/ProductVariant/9']]),
        imageUrls: ['x'],
      },
    );
    expect(update).toMatchObject({
      id: 'gid://shopify/Product/123',
      status: 'DRAFT',
      productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
    });
    expect(update.files).toBeUndefined();
    expect((update.variants as { id?: string }[])[0]!.id).toBe('gid://shopify/ProductVariant/9');
  });

  it('cria, define estoque no local e registra as etapas', async () => {
    const f = fakeFetch([
      {
        body: {
          data: {
            productSet: {
              product: {
                id: 'gid://shopify/Product/555',
                handle: 'camiseta',
                onlineStoreUrl: 'https://loja.com/products/camiseta',
                variants: {
                  nodes: [
                    { sku: 'FX-AZ', inventoryItem: { id: 'gid://shopify/InventoryItem/1' } },
                    { sku: 'FX-VM', inventoryItem: { id: 'gid://shopify/InventoryItem/2' } },
                  ],
                },
              },
              userErrors: [],
            },
          },
        },
      },
      { body: { data: { inventorySetQuantities: { userErrors: [] } } } },
    ]);
    const steps: string[] = [];
    const result = await publishShopify(f.fn, {
      domain: 'loja.myshopify.com',
      credentials: { access_token: 'shpat_x' },
      locationId: '777',
      payload: variable,
      imageUrls: [],
      onStep: async (s, ok) => {
        steps.push(`${s}:${ok}`);
      },
    });
    expect(result).toEqual({
      externalId: '555',
      url: 'https://loja.com/products/camiseta',
      stockWarning: null,
    });
    expect(steps).toEqual(['product:true', 'stock:true']);
    expect(f.calls[0]!.url).toBe('https://loja.myshopify.com/admin/api/2025-01/graphql.json');
    expect(f.calls[0]!.init.headers).toMatchObject({ 'x-shopify-access-token': 'shpat_x' });
    expect(f.body(1).variables.input.quantities).toEqual([
      {
        inventoryItemId: 'gid://shopify/InventoryItem/1',
        locationId: 'gid://shopify/Location/777',
        quantity: 40,
      },
      {
        inventoryItemId: 'gid://shopify/InventoryItem/2',
        locationId: 'gid://shopify/Location/777',
        quantity: 0,
      },
    ]);
  });

  it('erro de validação da Shopify e sem local de estoque', async () => {
    const refused = fakeFetch([
      {
        body: {
          data: { productSet: { product: null, userErrors: [{ message: 'Title is too long' }] } },
        },
      },
    ]);
    await expect(
      publishShopify(refused.fn, {
        domain: 'loja.myshopify.com',
        credentials: { access_token: 't' },
        locationId: '1',
        payload: simple,
        imageUrls: [],
      }),
    ).rejects.toThrow(new PublishError('Shopify: Title is too long'));

    const noLocation = fakeFetch([
      {
        body: {
          data: {
            productSet: {
              product: {
                id: 'gid://shopify/Product/1',
                handle: 'c',
                onlineStoreUrl: null,
                variants: { nodes: [] },
              },
              userErrors: [],
            },
          },
        },
      },
    ]);
    const result = await publishShopify(noLocation.fn, {
      domain: 'loja.myshopify.com',
      credentials: { access_token: 't' },
      locationId: null,
      payload: simple,
      imageUrls: [],
    });
    expect(result.url).toBe('https://loja.myshopify.com/admin/products/1');
    expect(result.stockWarning).toMatch(/Local de estoque/);
  });

  it('recusa domínio que não é da Shopify (anti-SSRF) e credencial recusada', async () => {
    await expect(
      publishShopify(fakeFetch([]).fn, {
        domain: 'evil.example.com',
        credentials: { access_token: 't' },
        locationId: '1',
        payload: simple,
        imageUrls: [],
      }),
    ).rejects.toThrow();
    const denied = fakeFetch([{ status: 401, body: {} }]);
    await expect(
      publishShopify(denied.fn, {
        domain: 'loja.myshopify.com',
        credentials: { access_token: 't' },
        locationId: '1',
        payload: simple,
        imageUrls: [],
      }),
    ).rejects.toThrow(/credenciais recusadas/);
  });
});

describe('WooCommerce', () => {
  it('produto simples com SKU, preço e estoque; variável com atributos', () => {
    expect(buildWooProduct(simple, ['https://img'], true)).toMatchObject({
      type: 'simple',
      status: 'publish',
      sku: 'CANECA',
      regular_price: '35.00',
      manage_stock: true,
      stock_quantity: 7,
      images: [{ src: 'https://img' }],
    });
    expect(buildWooProduct({ ...variable, target_status: 'paused' }, [], false)).toMatchObject({
      status: 'draft',
      attributes: [{ name: 'Cor', variation: true, options: ['Azul', 'Vermelho'] }],
    });
    expect(buildWooVariation(variable, variable.variants[0]!, 42)).toEqual({
      id: 42,
      sku: 'FX-AZ',
      regular_price: '69.90',
      manage_stock: true,
      stock_quantity: 40,
      attributes: [{ name: 'Cor', option: 'Azul' }],
    });
  });

  it('atualiza: casa variações pelo SKU e cria as que faltam', async () => {
    const f = fakeFetch([
      { body: { id: 88, permalink: 'https://loja.example.com/produto/camiseta' } },
      { body: [{ id: 5, sku: 'FX-AZ' }] },
      { body: { create: [{ id: 6 }], update: [{ id: 5 }] } },
    ]);
    const result = await publishWoo(f.fn, {
      baseUrl: 'https://loja.example.com',
      credentials: { consumer_key: 'ck', consumer_secret: 'cs' },
      payload: { ...variable, external_id: '88' },
      imageUrls: [],
    });
    expect(result).toEqual({
      externalId: '88',
      url: 'https://loja.example.com/produto/camiseta',
      stockWarning: null,
    });
    expect(
      f.calls.map(
        (c) => `${c.init.method} ${c.url.replace('https://loja.example.com/wp-json/wc/v3', '')}`,
      ),
    ).toEqual([
      'PUT /products/88',
      'GET /products/88/variations?per_page=100',
      'POST /products/88/variations/batch',
    ]);
    const batch = f.body(2);
    expect(batch.update.map((v: { id: number }) => v.id)).toEqual([5]);
    expect(batch.create.map((v: { sku: string }) => v.sku)).toEqual(['FX-VM']);
  });

  it('erro do WooCommerce (SKU duplicado) vira mensagem legível; pausar', async () => {
    const dup = fakeFetch([
      { status: 400, body: { code: 'product_invalid_sku', message: 'SKU já existe' } },
    ]);
    await expect(
      publishWoo(dup.fn, {
        baseUrl: 'https://loja.example.com',
        credentials: { consumer_key: 'ck', consumer_secret: 'cs' },
        payload: simple,
        imageUrls: [],
      }),
    ).rejects.toThrow('WooCommerce: HTTP 400 — SKU já existe');

    const pause = fakeFetch([{ body: { id: 1 } }]);
    await setWooStatus(pause.fn, {
      baseUrl: 'https://loja.example.com',
      credentials: { consumer_key: 'ck', consumer_secret: 'cs' },
      externalId: '1',
      status: 'paused',
    });
    expect(pause.body(0)).toEqual({ status: 'draft' });
    await expect(
      setWooStatus(pause.fn, {
        baseUrl: 'http://127.0.0.1',
        credentials: { consumer_key: 'ck', consumer_secret: 'cs' },
        externalId: '1',
        status: 'paused',
      }),
    ).rejects.toThrow();
  });
});
