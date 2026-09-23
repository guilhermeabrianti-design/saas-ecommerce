import { assertPublicHttpsUrl, assertShopifyDomain } from './crypto.ts';

/**
 * Envio do estoque disponível a cada marketplace. `fetch` é injetado para
 * testar sem rede. Toda falha vira `StockPushError` (mensagem curta, sem
 * segredos) e o worker registra com backoff.
 *
 * ATENÇÃO: os formatos de requisição seguem a documentação pública das APIs
 * (Shopify Admin GraphQL, WooCommerce REST v3), mas NÃO foram exercitados
 * contra lojas reais nesta entrega.
 */

export class StockPushError extends Error {}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ShopifyCredentials {
  access_token: string;
}
export interface WooCredentials {
  consumer_key: string;
  consumer_secret: string;
}

export const SHOPIFY_API_VERSION = '2025-01';
const TIMEOUT_MS = 15_000;

async function call(fetchFn: FetchFn, url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      ...init,
      redirect: 'error', // nunca seguir redirecionamento para outro host
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new StockPushError('sem resposta do marketplace (rede ou tempo esgotado)');
  }
  if (res.status === 401 || res.status === 403) {
    throw new StockPushError('credenciais recusadas pelo marketplace');
  }
  if (res.status === 429) throw new StockPushError('limite de requisições do marketplace');
  if (!res.ok) throw new StockPushError(`marketplace respondeu HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new StockPushError('resposta inválida do marketplace');
  }
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});

/** Shopify: acha a variação pelo SKU e define a quantidade "available" no local configurado. */
export async function pushShopifyStock(
  fetchFn: FetchFn,
  args: {
    domain: string;
    credentials: ShopifyCredentials;
    locationId: string;
    sku: string;
    available: number;
  },
): Promise<void> {
  const domain = assertShopifyDomain(args.domain);
  const locationId = args.locationId.replace(/^gid:\/\/shopify\/Location\//, '');
  if (!/^\d{1,20}$/.test(locationId)) throw new StockPushError('id do local de estoque inválido');
  const endpoint = `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const headers = {
    'content-type': 'application/json',
    'x-shopify-access-token': args.credentials.access_token,
  };
  const gql = async (query: string, variables: Json): Promise<Json> => {
    const body = obj(
      await call(fetchFn, endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
      }),
    );
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      throw new StockPushError('a Shopify recusou a consulta (verifique permissões do token)');
    }
    return obj(body.data);
  };

  const escaped = args.sku.replace(/["\\]/g, '\\$&');
  const found = obj(
    (
      await gql(
        `query($q: String!) { productVariants(first: 5, query: $q) { nodes { sku inventoryItem { id } } } }`,
        { q: `sku:"${escaped}"` },
      )
    ).productVariants,
  );
  const nodes = (Array.isArray(found.nodes) ? found.nodes : [])
    .map(obj)
    .filter((n) => n.sku === args.sku);
  if (nodes.length === 0) throw new StockPushError(`SKU ${args.sku} não encontrado na Shopify`);
  if (nodes.length > 1) throw new StockPushError(`SKU ${args.sku} duplicado na Shopify`);
  const inventoryItemId = obj(nodes[0]!.inventoryItem).id;
  if (typeof inventoryItemId !== 'string') throw new StockPushError('variação sem item de estoque');

  const result = obj(
    (
      await gql(
        `mutation($input: InventorySetQuantitiesInput!) {
           inventorySetQuantities(input: $input) { userErrors { field message } }
         }`,
        {
          input: {
            name: 'available',
            reason: 'correction',
            ignoreCompareQuantity: true,
            quantities: [
              {
                inventoryItemId,
                locationId: `gid://shopify/Location/${locationId}`,
                quantity: args.available,
              },
            ],
          },
        },
      )
    ).inventorySetQuantities,
  );
  const errors = Array.isArray(result.userErrors) ? result.userErrors : [];
  if (errors.length > 0) {
    throw new StockPushError(`Shopify: ${String(obj(errors[0]).message ?? 'erro ao atualizar')}`);
  }
}

/** WooCommerce: produto simples pelo SKU; define manage_stock e stock_quantity. */
export async function pushWooStock(
  fetchFn: FetchFn,
  args: {
    baseUrl: string;
    credentials: WooCredentials;
    sku: string;
    available: number;
  },
): Promise<void> {
  const base = assertPublicHttpsUrl(args.baseUrl);
  const root = `${base.origin}${base.pathname.replace(/\/+$/, '')}/wp-json/wc/v3`;
  const auth = `Basic ${btoa(`${args.credentials.consumer_key}:${args.credentials.consumer_secret}`)}`;
  const headers = { authorization: auth, 'content-type': 'application/json' };

  const list = await call(
    fetchFn,
    `${root}/products?sku=${encodeURIComponent(args.sku)}&per_page=5`,
    { method: 'GET', headers },
  );
  const products = (Array.isArray(list) ? list : []).map(obj).filter((p) => p.sku === args.sku);
  if (products.length === 0) {
    throw new StockPushError(
      `SKU ${args.sku} não encontrado no WooCommerce (variações ainda não são suportadas)`,
    );
  }
  if (products.length > 1) throw new StockPushError(`SKU ${args.sku} duplicado no WooCommerce`);
  const product = products[0]!;
  if (product.type !== 'simple') {
    throw new StockPushError('apenas produtos simples são suportados no WooCommerce');
  }
  const id = Number(product.id);
  if (!Number.isInteger(id) || id <= 0) throw new StockPushError('produto sem id válido');

  await call(fetchFn, `${root}/products/${id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ manage_stock: true, stock_quantity: args.available }),
  });
}
