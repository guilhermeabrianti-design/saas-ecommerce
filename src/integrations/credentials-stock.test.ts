// @vitest-environment node
import {
  assertPublicHttpsUrl,
  assertShopifyDomain,
  decryptCredentials,
  encryptCredentials,
} from '../../supabase/functions/_shared/integrations/crypto';
import {
  StockPushError,
  pushShopifyStock,
  pushWooStock,
  type FetchFn,
} from '../../supabase/functions/_shared/integrations/stock';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const CONN = '11111111-2222-4333-8444-555555555555';

describe('criptografia de credenciais', () => {
  it('cifra e decifra, com IV novo a cada vez', async () => {
    const secret = JSON.stringify({ access_token: 'shpat_abc123' });
    const a = await encryptCredentials(KEY, secret, CONN);
    const b = await encryptCredentials(KEY, secret, CONN);
    expect(a).toMatch(/^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('shpat_abc123');
    expect(await decryptCredentials(KEY, a, CONN)).toBe(secret);
  });

  it('não decifra em outra conexão, com outra chave ou se for adulterado', async () => {
    const token = await encryptCredentials(KEY, 'segredo', CONN);
    await expect(
      decryptCredentials(KEY, token, '99999999-2222-4333-8444-555555555555'),
    ).rejects.toThrow(/decifrar/);
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    await expect(decryptCredentials(other, token, CONN)).rejects.toThrow(/decifrar/);
    const [v, iv, ct] = token.split('.');
    const flipped = `${v}.${iv}.${ct!.slice(0, -4)}AAAA`;
    await expect(decryptCredentials(KEY, flipped, CONN)).rejects.toThrow(/decifrar/);
  });

  it('recusa formato desconhecido e chave com tamanho errado', async () => {
    await expect(decryptCredentials(KEY, 'v2.a.b', CONN)).rejects.toThrow(/formato/);
    await expect(decryptCredentials(KEY, 'lixo', CONN)).rejects.toThrow(/formato/);
    await expect(encryptCredentials(btoa('curta'), 'x', CONN)).rejects.toThrow(/32 bytes/);
    await expect(encryptCredentials('***', 'x', CONN)).rejects.toThrow(/base64/);
  });
});

describe('proteção contra SSRF', () => {
  it('aceita só https público por nome', () => {
    expect(assertPublicHttpsUrl('https://loja.com.br/').origin).toBe('https://loja.com.br');
    expect(assertPublicHttpsUrl(' https://loja.com.br:443/blog ').pathname).toBe('/blog');
  });

  it('recusa http, IPs, localhost, portas, credenciais na URL e nomes internos', () => {
    for (const bad of [
      'http://loja.com.br',
      'https://127.0.0.1',
      'https://169.254.169.254/latest',
      'https://[::1]/',
      'https://localhost',
      'https://loja',
      'https://servidor.internal',
      'https://minha.local',
      'https://loja.com.br:8443',
      'https://user:pass@loja.com.br',
      'ftp://loja.com.br',
      'não é url',
    ]) {
      expect(() => assertPublicHttpsUrl(bad), bad).toThrow();
    }
  });

  it('domínio Shopify precisa ser *.myshopify.com', () => {
    expect(assertShopifyDomain(' Loja-1.MyShopify.com ')).toBe('loja-1.myshopify.com');
    for (const bad of ['evil.com', 'loja.myshopify.com.evil.com', 'a/b.myshopify.com', '']) {
      expect(() => assertShopifyDomain(bad), bad).toThrow();
    }
  });
});

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(responses: (Response | Error)[]): { fn: FetchFn; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const queue = [...responses];
  const fn: FetchFn = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error('resposta não prevista no teste');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, calls };
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const shopifyArgs = {
  domain: 'loja.myshopify.com',
  credentials: { access_token: 'shpat_x' },
  locationId: 'gid://shopify/Location/998877',
  sku: 'CANECA-SHOP',
  available: 7,
};

describe('Shopify: envio de estoque', () => {
  const variantFound = () =>
    jsonRes({
      data: {
        productVariants: {
          nodes: [{ sku: 'CANECA-SHOP', inventoryItem: { id: 'gid://shopify/InventoryItem/1' } }],
        },
      },
    });
  const okMutation = () => jsonRes({ data: { inventorySetQuantities: { userErrors: [] } } });

  it('busca a variação pelo SKU e define o disponível no local', async () => {
    const { fn, calls } = fakeFetch([variantFound(), okMutation()]);
    await pushShopifyStock(fn, shopifyArgs);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://loja.myshopify.com/admin/api/2025-01/graphql.json');
    expect(calls[0]!.headers['x-shopify-access-token']).toBe('shpat_x');
    expect(calls[0]!.body).toMatchObject({ variables: { q: 'sku:"CANECA-SHOP"' } });
    expect(calls[1]!.body).toMatchObject({
      variables: {
        input: {
          name: 'available',
          quantities: [
            {
              inventoryItemId: 'gid://shopify/InventoryItem/1',
              locationId: 'gid://shopify/Location/998877',
              quantity: 7,
            },
          ],
        },
      },
    });
  });

  it('escapa aspas do SKU na consulta', async () => {
    const { fn, calls } = fakeFetch([jsonRes({ data: { productVariants: { nodes: [] } } })]);
    await expect(pushShopifyStock(fn, { ...shopifyArgs, sku: 'A"B' })).rejects.toThrow(
      StockPushError,
    );
    expect(calls[0]!.body).toMatchObject({ variables: { q: 'sku:"A\\"B"' } });
  });

  it('falha com mensagem clara para SKU ausente, duplicado ou erro do usuário', async () => {
    await expect(
      pushShopifyStock(
        fakeFetch([jsonRes({ data: { productVariants: { nodes: [] } } })]).fn,
        shopifyArgs,
      ),
    ).rejects.toThrow(/não encontrado/);

    const dup = { sku: 'CANECA-SHOP', inventoryItem: { id: 'gid://x/1' } };
    await expect(
      pushShopifyStock(
        fakeFetch([jsonRes({ data: { productVariants: { nodes: [dup, dup] } } })]).fn,
        shopifyArgs,
      ),
    ).rejects.toThrow(/duplicado/);

    await expect(
      pushShopifyStock(
        fakeFetch([
          variantFound(),
          jsonRes({
            data: { inventorySetQuantities: { userErrors: [{ message: 'Local inválido' }] } },
          }),
        ]).fn,
        shopifyArgs,
      ),
    ).rejects.toThrow(/Local inválido/);
  });

  it('traduz HTTP 401, 429, 500, rede e erro GraphQL sem vazar o token', async () => {
    for (const [res, expected] of [
      [new Response('x', { status: 401 }), /credenciais recusadas/],
      [new Response('x', { status: 429 }), /limite de requisições/],
      [new Response('x', { status: 500 }), /HTTP 500/],
      [new Error('ECONNRESET shpat_x'), /sem resposta/],
      [jsonRes({ errors: [{ message: 'Access denied' }] }), /permiss/],
    ] as const) {
      const err = await pushShopifyStock(fakeFetch([res]).fn, shopifyArgs).catch((e: Error) => e);
      expect(err).toBeInstanceOf(StockPushError);
      expect((err as Error).message).toMatch(expected);
      expect((err as Error).message).not.toContain('shpat_x');
    }
  });

  it('recusa domínio fora de myshopify.com e local inválido antes de qualquer chamada', async () => {
    const { fn, calls } = fakeFetch([]);
    await expect(pushShopifyStock(fn, { ...shopifyArgs, domain: 'evil.com' })).rejects.toThrow();
    await expect(pushShopifyStock(fn, { ...shopifyArgs, locationId: '12; drop' })).rejects.toThrow(
      /local/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('WooCommerce: envio de estoque', () => {
  const args = {
    baseUrl: 'https://loja.com.br/',
    credentials: { consumer_key: 'ck_1', consumer_secret: 'cs_1' },
    sku: 'COPO-WOO',
    available: 4,
  };

  it('acha o produto simples pelo SKU e atualiza o estoque com Basic auth', async () => {
    const { fn, calls } = fakeFetch([
      jsonRes([{ id: 55, sku: 'COPO-WOO', type: 'simple' }]),
      jsonRes({ id: 55 }),
    ]);
    await pushWooStock(fn, args);
    expect(calls[0]!.url).toBe(
      'https://loja.com.br/wp-json/wc/v3/products?sku=COPO-WOO&per_page=5',
    );
    expect(calls[0]!.headers.authorization).toBe(`Basic ${btoa('ck_1:cs_1')}`);
    expect(calls[1]).toMatchObject({
      url: 'https://loja.com.br/wp-json/wc/v3/products/55',
      method: 'PUT',
      body: { manage_stock: true, stock_quantity: 4 },
    });
  });

  it('respeita subdiretório da instalação e codifica o SKU', async () => {
    const { fn, calls } = fakeFetch([
      jsonRes([{ id: 1, sku: 'A B/C', type: 'simple' }]),
      jsonRes({}),
    ]);
    await pushWooStock(fn, { ...args, baseUrl: 'https://site.com/loja/', sku: 'A B/C' });
    expect(calls[0]!.url).toBe(
      'https://site.com/loja/wp-json/wc/v3/products?sku=A%20B%2FC&per_page=5',
    );
  });

  it('explica SKU ausente, produto variável e duplicado', async () => {
    await expect(pushWooStock(fakeFetch([jsonRes([])]).fn, args)).rejects.toThrow(/não encontrado/);
    await expect(
      pushWooStock(fakeFetch([jsonRes([{ id: 1, sku: 'COPO-WOO', type: 'variable' }])]).fn, args),
    ).rejects.toThrow(/simples/);
    const p = { id: 1, sku: 'COPO-WOO', type: 'simple' };
    await expect(pushWooStock(fakeFetch([jsonRes([p, p])]).fn, args)).rejects.toThrow(/duplicado/);
  });

  it('ignora resultados com SKU diferente (busca aproximada do Woo)', async () => {
    await expect(
      pushWooStock(fakeFetch([jsonRes([{ id: 9, sku: 'COPO-WOO-2', type: 'simple' }])]).fn, args),
    ).rejects.toThrow(/não encontrado/);
  });

  it('recusa endereço inseguro antes de qualquer chamada', async () => {
    const { fn, calls } = fakeFetch([]);
    await expect(
      pushWooStock(fn, { ...args, baseUrl: 'https://169.254.169.254' }),
    ).rejects.toThrow();
    await expect(pushWooStock(fn, { ...args, baseUrl: 'http://loja.com.br' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
