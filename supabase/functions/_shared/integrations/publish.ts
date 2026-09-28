import { assertPublicHttpsUrl, assertShopifyDomain } from './crypto.ts';
import {
  SHOPIFY_API_VERSION,
  type FetchFn,
  type ShopifyCredentials,
  type WooCredentials,
} from './stock.ts';

/**
 * Publicação de anúncios (Fase 29): criar/atualizar produto com variações,
 * preço, SKU e fotos, definir o estoque e pausar/reativar — Shopify Admin
 * GraphQL e WooCommerce REST v3. `fetch` é injetado para testar sem rede.
 * Toda falha vira `PublishError` com mensagem curta e sem segredos.
 *
 * ATENÇÃO: os formatos seguem a documentação pública das APIs, mas NÃO
 * foram exercitados contra lojas reais nesta entrega. Teste numa loja de
 * desenvolvimento antes de usar em produção.
 */

export class PublishError extends Error {}

export interface PublishVariant {
  inventory_item_id: string;
  sku: string;
  price_cents: number;
  available: number;
  options: Record<string, string>;
}

export interface PublishPayload {
  title: string;
  description: string | null;
  external_id: string | null;
  target_status: 'active' | 'paused';
  option_names: string[];
  variants: PublishVariant[];
}

export interface PublishResult {
  externalId: string;
  url: string | null;
  /** Mensagem da etapa de estoque; nula quando não houve problema. */
  stockWarning: string | null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const TIMEOUT_MS = 20_000;

/** Centavos → "69.90" (texto, sem ponto flutuante). */
export function centsToDecimal(cents: number): string {
  const n = Math.round(cents);
  return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
}

/** Texto do vendedor → HTML seguro (parágrafos e quebras de linha). */
export function toHtml(text: string | null): string {
  if (!text) return '';
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped
    .split(/\n{2,}/)
    .map((p) => `<p>${p.trim().replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Valores distintos de cada opção, na ordem em que aparecem. */
export function optionValues(payload: PublishPayload): { name: string; values: string[] }[] {
  return payload.option_names.map((name) => ({
    name,
    values: [
      ...new Set(payload.variants.map((v) => v.options[name]).filter((x): x is string => !!x)),
    ],
  }));
}

async function call(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  label: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new PublishError(`${label}: sem resposta (rede ou tempo esgotado)`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new PublishError(`${label}: credenciais recusadas (confira as permissões do token)`);
  }
  if (res.status === 429)
    throw new PublishError(`${label}: limite de requisições, tente em instantes`);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    if (res.ok) throw new PublishError(`${label}: resposta inválida`);
  }
  if (!res.ok) {
    // WooCommerce devolve { code, message } (ex.: SKU duplicado).
    const message = typeof obj(body).message === 'string' ? String(obj(body).message) : '';
    throw new PublishError(
      `${label}: HTTP ${res.status}${message ? ` — ${message.slice(0, 200)}` : ''}`,
    );
  }
  return body;
}

// ---------------------------------------------------------------------
// Shopify
// ---------------------------------------------------------------------

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/(\d{1,20})$/;

export function buildShopifyProductSet(
  payload: PublishPayload,
  args: { existingVariantIds: Map<string, string>; imageUrls: string[] },
): Json {
  const options = optionValues(payload);
  const simple = options.length === 0;
  const input: Json = {
    title: payload.title,
    descriptionHtml: toHtml(payload.description),
    status: payload.target_status === 'paused' ? 'DRAFT' : 'ACTIVE',
    productOptions: simple
      ? [{ name: 'Title', values: [{ name: 'Default Title' }] }]
      : options.map((o) => ({ name: o.name, values: o.values.map((name) => ({ name })) })),
    variants: payload.variants.map((v) => {
      const id = args.existingVariantIds.get(v.sku);
      return {
        ...(id ? { id } : {}),
        optionValues: simple
          ? [{ optionName: 'Title', name: 'Default Title' }]
          : payload.option_names.map((n) => ({ optionName: n, name: v.options[n] })),
        price: centsToDecimal(v.price_cents),
        inventoryItem: { sku: v.sku, tracked: true },
      };
    }),
  };
  if (payload.external_id) {
    input.id = `gid://shopify/Product/${payload.external_id}`;
  } else if (args.imageUrls.length) {
    // Fotos só na criação (atualizar não duplica imagens).
    input.files = args.imageUrls.map((originalSource) => ({
      originalSource,
      contentType: 'IMAGE',
    }));
  }
  return input;
}

function shopifyClient(fetchFn: FetchFn, domainRaw: string, credentials: ShopifyCredentials) {
  const domain = assertShopifyDomain(domainRaw);
  const endpoint = `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const gql = async (query: string, variables: Json): Promise<Json> => {
    const body = obj(
      await call(
        fetchFn,
        endpoint,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-shopify-access-token': credentials.access_token,
          },
          body: JSON.stringify({ query, variables }),
        },
        'Shopify',
      ),
    );
    if (arr(body.errors).length > 0) {
      throw new PublishError(
        `Shopify recusou a consulta: ${String(obj(arr(body.errors)[0]).message ?? '').slice(0, 200)}`,
      );
    }
    return obj(body.data);
  };
  const userErrors = (result: Json) => {
    const errors = arr(result.userErrors);
    if (errors.length) {
      throw new PublishError(`Shopify: ${String(obj(errors[0]).message ?? 'erro').slice(0, 200)}`);
    }
  };
  return { domain, gql, userErrors };
}

/** Cria ou atualiza o produto e define o estoque no local configurado. */
export async function publishShopify(
  fetchFn: FetchFn,
  args: {
    domain: string;
    credentials: ShopifyCredentials;
    locationId: string | null;
    payload: PublishPayload;
    imageUrls: string[];
    onStep?: (step: 'product' | 'stock', ok: boolean, message: string) => Promise<void>;
  },
): Promise<PublishResult> {
  const { domain, gql, userErrors } = shopifyClient(fetchFn, args.domain, args.credentials);

  const existingVariantIds = new Map<string, string>();
  if (args.payload.external_id) {
    const found = obj(
      (
        await gql(
          `query($id: ID!) { product(id: $id) { variants(first: 100) { nodes { id sku } } } }`,
          {
            id: `gid://shopify/Product/${args.payload.external_id}`,
          },
        )
      ).product,
    );
    if (!Object.keys(found).length) {
      throw new PublishError('Shopify: o produto publicado antes não existe mais na loja');
    }
    for (const n of arr(obj(found.variants).nodes).map(obj)) {
      if (typeof n.sku === 'string' && typeof n.id === 'string')
        existingVariantIds.set(n.sku, n.id);
    }
  }

  const result = obj(
    (
      await gql(
        `mutation($input: ProductSetInput!, $synchronous: Boolean!) {
           productSet(synchronous: $synchronous, input: $input) {
             product { id handle onlineStoreUrl variants(first: 100) { nodes { sku inventoryItem { id } } } }
             userErrors { field message }
           }
         }`,
        {
          synchronous: true,
          input: buildShopifyProductSet(args.payload, {
            existingVariantIds,
            imageUrls: args.imageUrls,
          }),
        },
      )
    ).productSet,
  );
  userErrors(result);
  const product = obj(result.product);
  const match = PRODUCT_GID.exec(String(product.id ?? ''));
  if (!match) throw new PublishError('Shopify: resposta sem o id do produto');
  const externalId = match[1]!;
  const url =
    typeof product.onlineStoreUrl === 'string' && product.onlineStoreUrl.startsWith('https://')
      ? product.onlineStoreUrl
      : `https://${domain}/admin/products/${externalId}`;
  await args.onStep?.(
    'product',
    true,
    args.payload.external_id ? 'Produto atualizado na Shopify.' : 'Produto criado na Shopify.',
  );

  // Estoque: uma chamada com todas as variações.
  const location = (args.locationId ?? '').replace(/^gid:\/\/shopify\/Location\//, '');
  if (!/^\d{1,20}$/.test(location)) {
    const warning = 'Local de estoque não configurado: informe-o nas credenciais da conexão.';
    await args.onStep?.('stock', false, warning);
    return { externalId, url, stockWarning: warning };
  }
  const bySku = new Map(
    arr(obj(product.variants).nodes)
      .map(obj)
      .map((n) => [String(n.sku ?? ''), String(obj(n.inventoryItem).id ?? '')] as const),
  );
  const quantities = args.payload.variants.flatMap((v) => {
    const inventoryItemId = bySku.get(v.sku);
    return inventoryItemId
      ? [
          {
            inventoryItemId,
            locationId: `gid://shopify/Location/${location}`,
            quantity: v.available,
          },
        ]
      : [];
  });
  try {
    const stock = obj(
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
              quantities,
            },
          },
        )
      ).inventorySetQuantities,
    );
    userErrors(stock);
  } catch (e) {
    const warning = e instanceof PublishError ? e.message : 'Shopify: falha ao definir o estoque';
    await args.onStep?.('stock', false, warning);
    return { externalId, url, stockWarning: warning };
  }
  await args.onStep?.('stock', true, `Estoque definido em ${quantities.length} variação(ões).`);
  return { externalId, url, stockWarning: null };
}

export async function setShopifyStatus(
  fetchFn: FetchFn,
  args: {
    domain: string;
    credentials: ShopifyCredentials;
    externalId: string;
    status: 'active' | 'paused';
  },
): Promise<void> {
  const { gql, userErrors } = shopifyClient(fetchFn, args.domain, args.credentials);
  const result = obj(
    (
      await gql(
        `mutation($product: ProductUpdateInput!) {
           productUpdate(product: $product) { product { id status } userErrors { field message } }
         }`,
        {
          product: {
            id: `gid://shopify/Product/${args.externalId}`,
            status: args.status === 'paused' ? 'DRAFT' : 'ACTIVE',
          },
        },
      )
    ).productUpdate,
  );
  userErrors(result);
}

// ---------------------------------------------------------------------
// WooCommerce
// ---------------------------------------------------------------------

function wooClient(fetchFn: FetchFn, baseUrl: string, credentials: WooCredentials) {
  const base = assertPublicHttpsUrl(baseUrl);
  const root = `${base.origin}${base.pathname.replace(/\/+$/, '')}/wp-json/wc/v3`;
  const headers = {
    authorization: `Basic ${btoa(`${credentials.consumer_key}:${credentials.consumer_secret}`)}`,
    'content-type': 'application/json',
  };
  const request = (method: string, path: string, body?: unknown) =>
    call(
      fetchFn,
      `${root}${path}`,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      'WooCommerce',
    );
  return { request };
}

const wooStatus = (s: 'active' | 'paused') => (s === 'paused' ? 'draft' : 'publish');

export function buildWooProduct(
  payload: PublishPayload,
  imageUrls: string[],
  creating: boolean,
): Json {
  const options = optionValues(payload);
  const simple = options.length === 0;
  const product: Json = {
    name: payload.title,
    description: toHtml(payload.description),
    status: wooStatus(payload.target_status),
  };
  if (creating) {
    product.type = simple ? 'simple' : 'variable';
    if (imageUrls.length) product.images = imageUrls.map((src) => ({ src }));
  }
  if (simple) {
    const v = payload.variants[0]!;
    Object.assign(product, {
      sku: v.sku,
      regular_price: centsToDecimal(v.price_cents),
      manage_stock: true,
      stock_quantity: v.available,
    });
  } else {
    product.attributes = options.map((o, position) => ({
      name: o.name,
      position,
      visible: true,
      variation: true,
      options: o.values,
    }));
  }
  return product;
}

export function buildWooVariation(payload: PublishPayload, v: PublishVariant, id?: number): Json {
  return {
    ...(id ? { id } : {}),
    sku: v.sku,
    regular_price: centsToDecimal(v.price_cents),
    manage_stock: true,
    stock_quantity: v.available,
    attributes: payload.option_names.map((name) => ({ name, option: v.options[name] })),
  };
}

export async function publishWoo(
  fetchFn: FetchFn,
  args: {
    baseUrl: string;
    credentials: WooCredentials;
    payload: PublishPayload;
    imageUrls: string[];
    onStep?: (step: 'product' | 'stock', ok: boolean, message: string) => Promise<void>;
  },
): Promise<PublishResult> {
  const { request } = wooClient(fetchFn, args.baseUrl, args.credentials);
  const creating = !args.payload.external_id;
  const body = buildWooProduct(args.payload, args.imageUrls, creating);
  const product = obj(
    creating
      ? await request('POST', '/products', body)
      : await request('PUT', `/products/${encodeURIComponent(args.payload.external_id!)}`, body),
  );
  const id = Number(product.id);
  if (!Number.isInteger(id) || id <= 0)
    throw new PublishError('WooCommerce: resposta sem o id do produto');
  const url =
    typeof product.permalink === 'string' && product.permalink.startsWith('https://')
      ? product.permalink
      : null;
  await args.onStep?.(
    'product',
    true,
    creating ? 'Produto criado no WooCommerce.' : 'Produto atualizado no WooCommerce.',
  );

  if (args.payload.option_names.length === 0) {
    await args.onStep?.('stock', true, 'Estoque definido no produto.');
    return { externalId: String(id), url, stockWarning: null };
  }

  // Variações: atualiza as que já existem (pelo SKU) e cria as que faltam.
  const existing = new Map<string, number>();
  if (!creating) {
    for (const v of arr(await request('GET', `/products/${id}/variations?per_page=100`)).map(obj)) {
      if (typeof v.sku === 'string' && Number.isInteger(Number(v.id)))
        existing.set(v.sku, Number(v.id));
    }
  }
  const batch = {
    create: args.payload.variants
      .filter((v) => !existing.has(v.sku))
      .map((v) => buildWooVariation(args.payload, v)),
    update: args.payload.variants
      .filter((v) => existing.has(v.sku))
      .map((v) => buildWooVariation(args.payload, v, existing.get(v.sku))),
  };
  const result = obj(await request('POST', `/products/${id}/variations/batch`, batch));
  const failed = [...arr(result.create), ...arr(result.update)]
    .map(obj)
    .filter((x) => x.error && typeof x.error === 'object');
  if (failed.length) {
    const message = String(obj(failed[0]!.error).message ?? 'erro').slice(0, 200);
    const warning = `WooCommerce: ${failed.length} variação(ões) não salvas — ${message}`;
    await args.onStep?.('stock', false, warning);
    return { externalId: String(id), url, stockWarning: warning };
  }
  await args.onStep?.(
    'stock',
    true,
    `Preço e estoque de ${args.payload.variants.length} variação(ões).`,
  );
  return { externalId: String(id), url, stockWarning: null };
}

export async function setWooStatus(
  fetchFn: FetchFn,
  args: {
    baseUrl: string;
    credentials: WooCredentials;
    externalId: string;
    status: 'active' | 'paused';
  },
): Promise<void> {
  const { request } = wooClient(fetchFn, args.baseUrl, args.credentials);
  await request('PUT', `/products/${encodeURIComponent(args.externalId)}`, {
    status: wooStatus(args.status),
  });
}
