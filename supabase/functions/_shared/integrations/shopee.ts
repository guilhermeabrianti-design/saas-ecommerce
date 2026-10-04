import {
  NormalizeError,
  cleanPhone,
  compact,
  decimalToCents,
  hmacSha256Hex,
  onlyDigits,
  splitStreet,
  str,
  timingSafeEqual,
  toUf,
  type NormalizeResult,
} from './common.ts';
import type { MlTokens } from './mercadolivre.ts';
import { StockPushError, type FetchFn } from './stock.ts';

/**
 * Shopee (Fase 38): código puro usado pelas Edge Functions `shopee` e
 * `stock-sync`, testado com vitest em `src/integrations/`.
 *
 * Open Platform v2: toda chamada leva `partner_id`, `timestamp` e `sign`
 * (HMAC-SHA256 em hex com a partner key). Chamadas da loja somam
 * `access_token` e `shop_id` à assinatura. O token de acesso vale 4 horas e
 * o de renovação 30 dias (renovar devolve um novo par).
 *
 * ATENÇÃO: formatos conforme a documentação pública da Shopee Open
 * Platform. NÃO exercitado contra contas reais nesta entrega: valide com
 * uma loja de teste (sandbox) antes de produção.
 */

export const SHOPEE_HOSTS = {
  production: 'https://partner.shopeemobile.com',
  test: 'https://partner.test-stable.shopeemobile.com',
} as const;

export interface ShopeeApp {
  host: string;
  partnerId: string;
  partnerKey: string;
}

export interface ShopeeShop {
  accessToken: string;
  shopId: string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const SHOP_ID = /^\d{1,20}$/;
export const ORDER_SN = /^[A-Za-z0-9]{6,40}$/;

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------
// Assinatura e autorização da loja
// ---------------------------------------------------------------------

/** sign = HMAC-SHA256(partner_key, partner_id + path + timestamp [+ access_token + shop_id]). */
export function shopeeSign(
  app: ShopeeApp,
  path: string,
  timestamp: number,
  shop?: ShopeeShop,
): Promise<string> {
  const base = `${app.partnerId}${path}${timestamp}${shop ? `${shop.accessToken}${shop.shopId}` : ''}`;
  return hmacSha256Hex(app.partnerKey, base);
}

/** URL assinada: parâmetros comuns + os da chamada. */
export async function shopeeUrl(
  app: ShopeeApp,
  path: string,
  args: { timestamp?: number; shop?: ShopeeShop; query?: Record<string, string> } = {},
): Promise<string> {
  const timestamp = args.timestamp ?? nowSeconds();
  const q = new URLSearchParams({
    partner_id: app.partnerId,
    timestamp: String(timestamp),
    sign: await shopeeSign(app, path, timestamp, args.shop),
  });
  if (args.shop) {
    q.set('access_token', args.shop.accessToken);
    q.set('shop_id', args.shop.shopId);
  }
  for (const [k, v] of Object.entries(args.query ?? {})) q.set(k, v);
  return `${app.host}${path}?${q.toString()}`;
}

/**
 * Página onde o vendedor autoriza a loja. A Shopee devolve para `redirect`
 * acrescentando `code` e `shop_id` (o `state` vai dentro do redirect).
 */
export function authorizationUrl(app: ShopeeApp, redirect: string, timestamp?: number) {
  return shopeeUrl(app, '/api/v2/shop/auth_partner', {
    timestamp,
    query: { redirect },
  });
}

/** Resposta de token/get e access_token/get → mesmo formato do Mercado Livre (user_id = shop_id). */
export function parseShopeeTokens(body: unknown, shopId: string): MlTokens {
  const b = obj(body);
  if (str(b.error)) {
    throw new StockPushError(
      `Shopee: autorização recusada (${str(b.error).slice(0, 60)}${str(b.message) ? ` — ${str(b.message).slice(0, 120)}` : ''})`,
    );
  }
  const access = str(b.access_token);
  const refresh = str(b.refresh_token);
  const expires = Number(b.expire_in);
  if (!access || !refresh || !Number.isFinite(expires) || expires <= 0 || !SHOP_ID.test(shopId)) {
    throw new StockPushError('Shopee: resposta de token inválida');
  }
  return { access_token: access, refresh_token: refresh, expires_in: expires, user_id: shopId };
}

/** POST de token (código ou renovação), assinado sem loja. */
export async function requestShopeeTokens(
  fetchFn: FetchFn,
  app: ShopeeApp,
  args: { code: string; shopId: string } | { refreshToken: string; shopId: string },
): Promise<MlTokens> {
  const path = 'code' in args ? '/api/v2/auth/token/get' : '/api/v2/auth/access_token/get';
  const body =
    'code' in args
      ? { code: args.code, shop_id: Number(args.shopId), partner_id: Number(app.partnerId) }
      : {
          refresh_token: args.refreshToken,
          shop_id: Number(args.shopId),
          partner_id: Number(app.partnerId),
        };
  let res: Response;
  try {
    res = await fetchFn(await shopeeUrl(app, path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new StockPushError('Shopee: sem resposta (rede ou tempo esgotado)');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok && !str(obj(json).error))
    throw new StockPushError(`Shopee: token HTTP ${res.status}`);
  return parseShopeeTokens(json, args.shopId);
}

// ---------------------------------------------------------------------
// Chamadas da loja
// ---------------------------------------------------------------------

const AUTH_ERRORS =
  /^error_(auth|permission|token|shop)|invalid_access_token|invalid_acceess_token/i;

/** Corpo da Shopee → `response` (ou erro curto, sem segredos). */
export function unwrapShopee(status: number, body: unknown): Json {
  const b = obj(body);
  const error = str(b.error);
  if (status === 401 || status === 403 || AUTH_ERRORS.test(error))
    throw new StockPushError('Shopee: acesso recusado (reconecte a loja)');
  if (status === 429 || /too_many|rate_limit/i.test(error))
    throw new StockPushError('Shopee: limite de requisições');
  if (error || status >= 400) {
    const message = str(b.message);
    throw new StockPushError(
      `Shopee: ${error || `HTTP ${status}`}${message ? ` — ${message.slice(0, 200)}` : ''}`,
    );
  }
  return obj(b.response);
}

export interface ShopeeClient {
  get(path: string, query?: Record<string, string>): Promise<Json>;
  post(path: string, body: unknown): Promise<Json>;
  /** POST que devolve arquivo (etiqueta). */
  download(path: string, body: unknown): Promise<Uint8Array>;
}

export function shopeeClient(fetchFn: FetchFn, app: ShopeeApp, shop: ShopeeShop): ShopeeClient {
  const send = async (url: string, init: RequestInit) => {
    try {
      return await fetchFn(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new StockPushError('Shopee: sem resposta (rede ou tempo esgotado)');
    }
  };
  return {
    async get(path, query) {
      const res = await send(await shopeeUrl(app, path, { shop, query }), { method: 'GET' });
      return unwrapShopee(res.status, await res.json().catch(() => null));
    },
    async post(path, body) {
      const res = await send(await shopeeUrl(app, path, { shop }), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return unwrapShopee(res.status, await res.json().catch(() => null));
    },
    async download(path, body) {
      const res = await send(await shopeeUrl(app, path, { shop }), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const type = res.headers.get('content-type') ?? '';
      if (type.includes('json')) {
        unwrapShopee(res.status, await res.json().catch(() => null));
        throw new StockPushError('Shopee: etiqueta não veio como arquivo');
      }
      if (!res.ok) throw new StockPushError(`Shopee: etiqueta HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

// ---------------------------------------------------------------------
// Notificações (push)
// ---------------------------------------------------------------------

/** Authorization = HMAC-SHA256(partner_key, url + '|' + corpo bruto), em hex. */
export async function verifyShopeePush(
  partnerKey: string,
  url: string,
  rawBody: string,
  authorization: string | null,
): Promise<boolean> {
  if (!authorization) return false;
  const expected = await hmacSha256Hex(partnerKey, `${url}|${rawBody}`);
  return timingSafeEqual(expected, authorization.trim().toLowerCase());
}

export interface ShopeePush {
  shopId: string;
  orderSn: string;
}

/** Só pedidos: mudança de status (code 3) e número de rastreio (code 4). */
export function parseShopeePush(body: unknown): ShopeePush | null {
  const b = obj(body);
  const code = Number(b.code);
  if (code !== 3 && code !== 4) return null;
  const shopId = String(b.shop_id ?? '');
  const orderSn = str(obj(b.data).ordersn) || str(obj(b.data).order_sn);
  if (!SHOP_ID.test(shopId) || !ORDER_SN.test(orderSn)) return null;
  return { shopId, orderSn };
}

// ---------------------------------------------------------------------
// Pedidos
// ---------------------------------------------------------------------

export const ORDER_DETAIL_FIELDS = [
  'buyer_user_id',
  'buyer_username',
  'recipient_address',
  'item_list',
  'fulfillment_flag',
  'package_list',
  'shipping_carrier',
].join(',');

/** Pagos e ainda não enviados: entram e podem ir ao fornecedor. */
const INGEST_STATUSES = new Set(['READY_TO_SHIP', 'PROCESSED', 'RETRY_SHIP', 'INVOICE_PENDING']);

/** SKU do item no pedido (variação primeiro); sem SKU, o id da Shopee. */
export function shopeeItemKey(item: Json): string {
  const sku = str(item.model_sku) || str(item.item_sku);
  if (sku) return sku;
  const model = String(item.model_id ?? '0');
  if (model !== '0' && model !== '') return `model:${model}`;
  return item.item_id ? `item:${String(item.item_id)}` : '';
}

/**
 * Pedido (get_order_detail) → pedido normalizado. Pagos e não enviados
 * entram; não pagos, cancelados, já enviados e "enviado pela Shopee" não.
 */
export function normalizeShopeeOrder(order: unknown): NormalizeResult {
  const o = obj(order);
  const sn = str(o.order_sn);
  if (!ORDER_SN.test(sn)) throw new NormalizeError('pedido sem order_sn');
  const status = str(o.order_status);
  if (status === 'UNPAID') return { kind: 'skip', reason: 'aguardando pagamento' };
  if (status === 'CANCELLED' || status === 'IN_CANCEL')
    return { kind: 'skip', reason: `pedido ${status.toLowerCase()}` };
  if (!INGEST_STATUSES.has(status))
    return { kind: 'skip', reason: `já em andamento na Shopee (${status || 'sem status'})` };
  if (str(o.fulfillment_flag) === 'fulfilled_by_shopee')
    return { kind: 'skip', reason: 'enviado pelo estoque da Shopee (Full)' };

  const items = arr(o.item_list).map((raw) => {
    const it = obj(raw);
    const external = shopeeItemKey(it);
    if (!external) throw new NormalizeError('item sem SKU nem id');
    const quantity = Number(it.model_quantity_purchased);
    if (!Number.isInteger(quantity) || quantity < 1)
      throw new NormalizeError('quantidade inválida');
    const price = it.model_discounted_price ?? it.model_original_price;
    return {
      external_item_id: external,
      quantity,
      unit_price_cents: decimalToCents(String(price)),
    };
  });
  if (items.length === 0) throw new NormalizeError('pedido sem itens');

  const a = obj(o.recipient_address);
  // Endereço do Brasil vem como "Rua, número, complemento, bairro, cidade, UF, CEP".
  const parts = str(a.full_address)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  let street = parts[0] ?? '';
  let number = 'S/N';
  if (parts[1] && /^(\d+[A-Za-z]?|s\/?n)$/i.test(parts[1])) {
    number = /^s\/?n$/i.test(parts[1]) ? 'S/N' : parts[1];
  } else {
    ({ street, number } = splitStreet(street));
  }
  const district = str(a.town) || str(a.district);
  const city = str(a.city);
  const knownTail = new Set(
    [district, str(a.district), city, str(a.state), onlyDigits(a.zipcode)].filter(Boolean),
  );
  // Complemento: o primeiro trecho depois do número que não é bairro, cidade, UF ou CEP.
  const complement = /^(\d+[A-Za-z]?|s\/?n)$/i.test(parts[1] ?? '')
    ? (parts
        .slice(2)
        .find(
          (p) =>
            !knownTail.has(p) &&
            !knownTail.has(onlyDigits(p)) &&
            toUf(p) === '' &&
            !/^brasil$/i.test(p),
        ) ?? '')
    : '';

  return {
    kind: 'order',
    externalId: sn,
    order: compact({
      customer_name: str(a.name) || str(o.buyer_username),
      customer_phone: cleanPhone(a.phone),
      ship_postal_code: onlyDigits(a.zipcode),
      ship_street: street,
      ship_number: number,
      ship_complement: complement.slice(0, 120) || undefined,
      ship_district: district || 'Não informado',
      ship_city: city,
      ship_state: toUf(a.state),
      shipping_cents: 0,
      discount_cents: 0,
      notes: `Shopee #${sn}`,
      items,
    }),
  };
}

/** Referências item:variação dos SKUs do pedido (guardadas para o envio de estoque). */
export function shopeeItemRefs(order: unknown): { sku: string; ref: string }[] {
  const seen = new Map<string, string>();
  for (const raw of arr(obj(order).item_list)) {
    const it = obj(raw);
    const sku = str(it.model_sku) || str(it.item_sku);
    const item = String(it.item_id ?? '');
    const model = String(it.model_id ?? '0') || '0';
    if (sku && /^\d{1,20}$/.test(item) && /^\d{1,20}$/.test(model)) {
      seen.set(sku, `${item}:${model}`);
    }
  }
  return [...seen].map(([sku, ref]) => ({ sku, ref }));
}

// ---------------------------------------------------------------------
// Organizar o envio e etiqueta
// ---------------------------------------------------------------------

/**
 * Organiza o envio por postagem (dropoff) quando a Shopee não pede nada
 * além disso. Coleta (pickup) exige endereço e horário: fica para o
 * vendedor na Shopee. Devolve true quando organizou.
 */
export async function arrangeDropoff(api: ShopeeClient, orderSn: string): Promise<boolean> {
  const param = await api.get('/api/v2/logistics/get_shipping_parameter', { order_sn: orderSn });
  const needed = obj(param.info_needed);
  if (!Array.isArray(needed.dropoff) || needed.dropoff.length > 0) return false;
  await api.post('/api/v2/logistics/ship_order', { order_sn: orderSn, dropoff: {} });
  return true;
}

const DOCUMENT_TYPES = new Set(['NORMAL_AIR_WAYBILL', 'THERMAL_AIR_WAYBILL']);

export type ShopeeLabel =
  | { kind: 'ready'; bytes: Uint8Array; tracking: string | undefined; ref: string }
  | { kind: 'pending'; reason: string };

export const LABEL_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Etiqueta da Shopee: rastreio → tipo sugerido → criar → aguardar → baixar.
 * Sem rastreio (envio não organizado) ou ainda processando: "pending",
 * buscada de novo na próxima notificação ou no botão do pedido.
 */
export async function fetchShopeeLabel(
  api: ShopeeClient,
  orderSn: string,
  opts: { sleep?: (ms: number) => Promise<void>; attempts?: number } = {},
): Promise<ShopeeLabel> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const tracking = str(
    (await api.get('/api/v2/logistics/get_tracking_number', { order_sn: orderSn })).tracking_number,
  ).toUpperCase();
  if (!tracking) return { kind: 'pending', reason: 'envio ainda não organizado na Shopee' };

  const param = obj(
    arr(
      (
        await api.post('/api/v2/logistics/get_shipping_document_parameter', {
          order_list: [{ order_sn: orderSn }],
        })
      ).result_list,
    )[0],
  );
  const suggested = str(param.suggest_shipping_document_type);
  const type = DOCUMENT_TYPES.has(suggested) ? suggested : 'NORMAL_AIR_WAYBILL';

  await api.post('/api/v2/logistics/create_shipping_document', {
    order_list: [{ order_sn: orderSn, tracking_number: tracking, shipping_document_type: type }],
  });
  let status = '';
  for (let i = 0; i < (opts.attempts ?? 4); i++) {
    if (i > 0) await sleep(1500);
    const result = obj(
      arr(
        (
          await api.post('/api/v2/logistics/get_shipping_document_result', {
            order_list: [{ order_sn: orderSn }],
            shipping_document_type: type,
          })
        ).result_list,
      )[0],
    );
    status = str(result.status);
    if (status === 'READY' || status === 'FAILED') break;
  }
  if (status === 'FAILED') throw new StockPushError('Shopee: falha ao gerar a etiqueta');
  if (status !== 'READY') return { kind: 'pending', reason: 'etiqueta ainda sendo gerada' };

  const bytes = await api.download('/api/v2/logistics/download_shipping_document', {
    shipping_document_type: type,
    order_list: [{ order_sn: orderSn }],
  });
  if (bytes.length === 0 || bytes.length > LABEL_MAX_BYTES)
    throw new StockPushError('Shopee: etiqueta vazia ou grande demais');
  if (!new TextDecoder().decode(bytes.slice(0, 64)).trimStart().startsWith('%PDF'))
    throw new StockPushError('Shopee: etiqueta em formato inesperado');
  return {
    kind: 'ready',
    bytes,
    tracking: /^[A-Z0-9-]{4,60}$/.test(tracking) ? tracking : undefined,
    ref: orderSn,
  };
}

// ---------------------------------------------------------------------
// Estoque
// ---------------------------------------------------------------------

const REF = /^(\d{1,20}):(\d{1,20})$/;

/** Acha item e variação pelo SKU (SKU do anúncio ou da variação). */
export async function resolveShopeeSku(api: ShopeeClient, sku: string): Promise<string> {
  const found = await api.get('/api/v2/product/search_item', {
    offset: '0',
    page_size: '10',
    item_sku: sku,
  });
  const ids = arr(found.item_id_list)
    .map(String)
    .filter((id) => /^\d{1,20}$/.test(id));
  if (ids.length === 0)
    throw new StockPushError(
      `SKU ${sku} não encontrado na Shopee (variações são reconhecidas a partir do primeiro pedido)`,
    );
  const info = await api.get('/api/v2/product/get_item_base_info', {
    item_id_list: ids.join(','),
  });
  const matches: string[] = [];
  for (const raw of arr(info.item_list)) {
    const item = obj(raw);
    const id = String(item.item_id ?? '');
    if (!ids.includes(id)) continue;
    if (item.has_model) {
      const models = await api.get('/api/v2/product/get_model_list', { item_id: id });
      for (const m of arr(models.model).map(obj)) {
        if (str(m.model_sku) === sku) matches.push(`${id}:${String(m.model_id)}`);
      }
    } else if (str(item.item_sku) === sku) {
      matches.push(`${id}:0`);
    }
  }
  if (matches.length === 0)
    throw new StockPushError(`SKU ${sku}: nenhum anúncio ou variação com esse SKU exato na Shopee`);
  if (matches.length > 1)
    throw new StockPushError(`SKU ${sku} em mais de um anúncio ou variação na Shopee`);
  return matches[0]!;
}

/**
 * Define o estoque do vendedor (seller_stock) do item/variação. Usa a
 * referência guardada quando houver; senão procura pelo SKU. Devolve a
 * referência usada (para guardar).
 */
export async function pushShopeeStock(
  api: ShopeeClient,
  args: { sku: string; available: number; ref: string | null },
): Promise<string> {
  const ref = args.ref && REF.test(args.ref) ? args.ref : await resolveShopeeSku(api, args.sku);
  const [, item, model] = REF.exec(ref)!;
  const result = await api.post('/api/v2/product/update_stock', {
    item_id: Number(item),
    stock_list: [{ model_id: Number(model), seller_stock: [{ stock: args.available }] }],
  });
  const failed = arr(result.failure_list).map(obj)[0];
  if (failed) {
    throw new StockPushError(
      `Shopee: estoque recusado para ${args.sku}${str(failed.failed_reason) ? ` — ${str(failed.failed_reason).slice(0, 200)}` : ''}`,
    );
  }
  return ref;
}
