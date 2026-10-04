import {
  NormalizeError,
  cleanDocument,
  cleanEmail,
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
 * TikTok Shop (Fase 39): código puro usado pelas Edge Functions `tiktok` e
 * `stock-sync`, testado com vitest em `src/integrations/`.
 *
 * Partner API (versão 202309): chamadas assinadas com HMAC-SHA256 (hex) da
 * app secret sobre `secret + caminho + parâmetros ordenados + corpo +
 * secret`; o token vai no cabeçalho `x-tts-access-token` e a loja no
 * parâmetro `shop_cipher` (obtido depois da autorização).
 *
 * ATENÇÃO: formatos conforme a documentação pública da TikTok Shop Partner
 * Center. NÃO exercitado contra contas reais nesta entrega: valide com uma
 * loja de teste antes de produção.
 */

export const TIKTOK_AUTH_URL = 'https://services.tiktokshop.com/open/authorize';
export const TIKTOK_AUTH_API = 'https://auth.tiktok-shops.com';
export const TIKTOK_API = 'https://open-api.tiktokglobalshop.com';

export interface TikTokApp {
  appKey: string;
  appSecret: string;
  serviceId: string;
}

export interface TikTokShop {
  accessToken: string;
  shopCipher: string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const SHOP_ID = /^\d{1,20}$/;
export const ORDER_ID = /^\d{6,30}$/;
const CIPHER = /^[A-Za-z0-9_-]{1,200}$/;

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------
// Assinatura e autorização
// ---------------------------------------------------------------------

/**
 * sign = hex(HMAC-SHA256(secret, secret + path + k1v1k2v2… + body + secret)),
 * com os parâmetros ordenados, sem `sign` e `access_token`.
 */
export function tiktokSign(
  secret: string,
  path: string,
  params: Record<string, string>,
  body = '',
): Promise<string> {
  const pairs = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join('');
  return hmacSha256Hex(secret, `${secret}${path}${pairs}${body}${secret}`);
}

export function authorizationUrl(app: TikTokApp, state: string): string {
  const q = new URLSearchParams({ service_id: app.serviceId, state });
  return `${TIKTOK_AUTH_URL}?${q.toString()}`;
}

/** Resposta de token/get e token/refresh → formato comum (user_id = open_id). */
export function parseTikTokTokens(body: unknown, now = nowSeconds()): MlTokens {
  const b = obj(body);
  if (Number(b.code) !== 0) {
    throw new StockPushError(
      `TikTok Shop: autorização recusada (${String(b.code ?? '?').slice(0, 20)}${str(b.message) ? ` — ${str(b.message).slice(0, 120)}` : ''})`,
    );
  }
  const d = obj(b.data);
  const access = str(d.access_token);
  const refresh = str(d.refresh_token);
  // A TikTok Shop devolve o vencimento como data (segundos), não duração.
  const expiresAt = Number(d.access_token_expire_in);
  const openId = str(d.open_id);
  if (!access || !refresh || !Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new StockPushError('TikTok Shop: resposta de token inválida');
  }
  return {
    access_token: access,
    refresh_token: refresh,
    expires_in: expiresAt - now,
    user_id: openId,
  };
}

/** Troca do código ou renovação (GET em auth.tiktok-shops.com, sem assinatura). */
export async function requestTikTokTokens(
  fetchFn: FetchFn,
  app: TikTokApp,
  args: { code: string } | { refreshToken: string },
): Promise<MlTokens> {
  const q = new URLSearchParams({ app_key: app.appKey, app_secret: app.appSecret });
  let path: string;
  if ('code' in args) {
    path = '/api/v2/token/get';
    q.set('auth_code', args.code);
    q.set('grant_type', 'authorized_code');
  } else {
    path = '/api/v2/token/refresh';
    q.set('refresh_token', args.refreshToken);
    q.set('grant_type', 'refresh_token');
  }
  let res: Response;
  try {
    res = await fetchFn(`${TIKTOK_AUTH_API}${path}?${q.toString()}`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new StockPushError('TikTok Shop: sem resposta (rede ou tempo esgotado)');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok && json == null) throw new StockPushError(`TikTok Shop: token HTTP ${res.status}`);
  return parseTikTokTokens(json);
}

export interface AuthorizedShop {
  id: string;
  cipher: string;
  name: string;
  region: string;
}

/** Lojas autorizadas: prefere a do Brasil; senão a primeira. */
export function pickShop(data: unknown): AuthorizedShop | null {
  const shops = arr(obj(data).shops)
    .map(obj)
    .map((s) => ({
      id: String(s.id ?? ''),
      cipher: str(s.cipher),
      name: str(s.name).slice(0, 80),
      region: str(s.region).toUpperCase(),
    }))
    .filter((s) => SHOP_ID.test(s.id) && CIPHER.test(s.cipher));
  return shops.find((s) => s.region === 'BR') ?? shops[0] ?? null;
}

// ---------------------------------------------------------------------
// Chamadas da loja
// ---------------------------------------------------------------------

/** Corpo da TikTok Shop → `data` (ou erro curto, sem segredos). */
export function unwrapTikTok(status: number, body: unknown): Json {
  const b = obj(body);
  const code = Number(b.code);
  const message = str(b.message);
  if (status === 401 || status === 403 || [105001, 105002, 105005, 36009004].includes(code))
    throw new StockPushError('TikTok Shop: acesso recusado (reconecte a loja)');
  if (status === 429 || code === 36009007 || /rate limit|too many/i.test(message))
    throw new StockPushError('TikTok Shop: limite de requisições');
  if (status >= 400 || !Number.isFinite(code) || code !== 0) {
    throw new StockPushError(
      `TikTok Shop: ${Number.isFinite(code) && code !== 0 ? `erro ${code}` : `HTTP ${status}`}${message ? ` — ${message.slice(0, 200)}` : ''}`,
    );
  }
  return obj(b.data);
}

export interface TikTokClient {
  get(path: string, query?: Record<string, string>): Promise<Json>;
  post(path: string, body: unknown, query?: Record<string, string>): Promise<Json>;
  put(path: string, body: unknown): Promise<Json>;
}

/** URL assinada de uma chamada (app_key, timestamp, shop_cipher quando há loja). */
export async function tiktokUrl(
  app: TikTokApp,
  path: string,
  args: { shopCipher?: string; query?: Record<string, string>; body?: string; timestamp?: number },
): Promise<string> {
  const params: Record<string, string> = {
    app_key: app.appKey,
    timestamp: String(args.timestamp ?? nowSeconds()),
    ...(args.shopCipher ? { shop_cipher: args.shopCipher } : {}),
    ...(args.query ?? {}),
  };
  const sign = await tiktokSign(app.appSecret, path, params, args.body ?? '');
  const q = new URLSearchParams({ ...params, sign });
  return `${TIKTOK_API}${path}?${q.toString()}`;
}

export function tiktokClient(
  fetchFn: FetchFn,
  app: TikTokApp,
  auth: { accessToken: string; shopCipher?: string },
): TikTokClient {
  const send = async (url: string, init: RequestInit) => {
    let res: Response;
    try {
      res = await fetchFn(url, {
        ...init,
        headers: {
          'x-tts-access-token': auth.accessToken,
          'content-type': 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new StockPushError('TikTok Shop: sem resposta (rede ou tempo esgotado)');
    }
    return unwrapTikTok(res.status, await res.json().catch(() => null));
  };
  return {
    async get(path, query) {
      return send(await tiktokUrl(app, path, { shopCipher: auth.shopCipher, query }), {
        method: 'GET',
      });
    },
    async post(path, body, query) {
      const raw = JSON.stringify(body);
      return send(await tiktokUrl(app, path, { shopCipher: auth.shopCipher, query, body: raw }), {
        method: 'POST',
        body: raw,
      });
    },
    async put(path, body) {
      const raw = JSON.stringify(body);
      return send(await tiktokUrl(app, path, { shopCipher: auth.shopCipher, body: raw }), {
        method: 'PUT',
        body: raw,
      });
    },
  };
}

// ---------------------------------------------------------------------
// Notificações (webhook)
// ---------------------------------------------------------------------

/** Authorization = hex(HMAC-SHA256(app_secret, app_key + corpo bruto)). */
export async function verifyTikTokWebhook(
  app: TikTokApp,
  rawBody: string,
  authorization: string | null,
): Promise<boolean> {
  if (!authorization) return false;
  const expected = await hmacSha256Hex(app.appSecret, `${app.appKey}${rawBody}`);
  return timingSafeEqual(expected, authorization.trim().toLowerCase());
}

export interface TikTokWebhook {
  shopId: string;
  orderId: string;
}

/** Só mudança de status de pedido (type 1). */
export function parseTikTokWebhook(body: unknown): TikTokWebhook | null {
  const b = obj(body);
  if (Number(b.type) !== 1) return null;
  const shopId = String(b.shop_id ?? '');
  const orderId = String(obj(b.data).order_id ?? '');
  if (!SHOP_ID.test(shopId) || !ORDER_ID.test(orderId)) return null;
  return { shopId, orderId };
}

// ---------------------------------------------------------------------
// Pedidos
// ---------------------------------------------------------------------

/** Nível do endereço (L1 estado, L2 cidade, L3 bairro), pelo nível ou pelo nome. */
function addressLevel(address: Json, level: string, names: string[]): string {
  const info = arr(address.district_info).map(obj);
  const hit =
    info.find((d) => str(d.address_level).toUpperCase() === level) ??
    info.find((d) => names.includes(str(d.address_level_name).toLowerCase()));
  return str(hit?.address_name);
}

/** SKU do vendedor; sem SKU, o id da TikTok Shop. */
export const tiktokItemKey = (li: Json) =>
  str(li.seller_sku) || (li.sku_id ? `sku:${String(li.sku_id)}` : '');

/**
 * Pedido (GET /order/202309/orders) → pedido normalizado. Só "aguardando
 * envio" e enviado pelo vendedor entra; em espera (ON_HOLD), não pago,
 * cancelado, já enviado e "enviado pela TikTok" ficam de fora.
 */
export function normalizeTikTokOrder(order: unknown): NormalizeResult {
  const o = obj(order);
  const id = String(o.id ?? '');
  if (!ORDER_ID.test(id)) throw new NormalizeError('pedido sem id');
  const status = str(o.status);
  if (status === 'UNPAID') return { kind: 'skip', reason: 'aguardando pagamento' };
  if (status === 'ON_HOLD') return { kind: 'skip', reason: 'em período de espera da TikTok Shop' };
  if (status === 'CANCELLED') return { kind: 'skip', reason: 'pedido cancelado' };
  if (status !== 'AWAITING_SHIPMENT')
    return { kind: 'skip', reason: `já em andamento na TikTok Shop (${status || 'sem status'})` };
  if (str(o.fulfillment_type) === 'FULFILLMENT_BY_TIKTOK')
    return { kind: 'skip', reason: 'enviado pelo estoque da TikTok Shop' };

  // Cada unidade é uma linha: agrupa por SKU e preço.
  const grouped = new Map<
    string,
    { external_item_id: string; quantity: number; unit_price_cents: number }
  >();
  for (const raw of arr(o.line_items)) {
    const li = obj(raw);
    if (str(li.display_status) === 'CANCELLED' || li.is_gift === true) continue;
    const external = tiktokItemKey(li);
    if (!external) throw new NormalizeError('item sem SKU nem id');
    const price = decimalToCents(String(li.sale_price ?? li.original_price));
    const key = `${external}|${price}`;
    const cur = grouped.get(key);
    if (cur) cur.quantity += 1;
    else grouped.set(key, { external_item_id: external, quantity: 1, unit_price_cents: price });
  }
  const items = [...grouped.values()];
  if (items.length === 0) throw new NormalizeError('pedido sem itens');

  const a = obj(o.recipient_address);
  const line1 = str(a.address_line1) || str(a.address_detail);
  const line2 = str(a.address_line2);
  let street = line1;
  let number = 'S/N';
  if (/^(\d+[A-Za-z]?|s\/?n)$/i.test(line2)) {
    number = /^s\/?n$/i.test(line2) ? 'S/N' : line2;
  } else {
    ({ street, number } = splitStreet(line1));
  }
  const complement = [line2 && number !== line2 ? line2 : '', str(a.address_line3)]
    .filter(Boolean)
    .join(', ');
  const payment = obj(o.payment);

  return {
    kind: 'order',
    externalId: id,
    order: compact({
      customer_name: str(a.name) || `${str(a.first_name)} ${str(a.last_name)}`.trim(),
      customer_email: cleanEmail(o.buyer_email),
      customer_phone: cleanPhone(a.phone_number),
      customer_document: cleanDocument(o.cpf),
      ship_postal_code: onlyDigits(a.postal_code),
      ship_street: street,
      ship_number: number,
      ship_complement: complement.slice(0, 120) || undefined,
      ship_district:
        addressLevel(a, 'L3', ['district', 'neighborhood', 'bairro']) || 'Não informado',
      ship_city: addressLevel(a, 'L2', ['city', 'cidade', 'municipality']),
      ship_state: toUf(addressLevel(a, 'L1', ['state', 'estado'])),
      shipping_cents:
        payment.shipping_fee == null ? 0 : decimalToCents(String(payment.shipping_fee)),
      discount_cents: 0,
      notes: `TikTok Shop #${id}`,
      items,
    }),
  };
}

/** Pacotes do pedido (a etiqueta é por pacote). */
export function tiktokPackages(order: unknown): string[] {
  const ids = new Set<string>();
  for (const p of arr(obj(order).packages)) {
    const id = String(obj(p).id ?? '');
    if (/^\d{1,30}$/.test(id)) ids.add(id);
  }
  return [...ids];
}

// ---------------------------------------------------------------------
// Envio e etiqueta
// ---------------------------------------------------------------------

/**
 * Organiza o envio do pacote por postagem (DROP_OFF) quando a logística é
 * da TikTok Shop. Logística própria do vendedor não tem etiqueta da TikTok.
 */
export async function shipPackageDropOff(api: TikTokClient, packageId: string): Promise<void> {
  await api.post(`/fulfillment/202309/packages/${packageId}/ship`, { handover_method: 'DROP_OFF' });
}

export const LABEL_MAX_BYTES = 5 * 1024 * 1024;

/** Só baixamos etiquetas de hosts da TikTok Shop. */
export function trustedDocumentUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    /(^|\.)(tiktokshop\.com|tiktokglobalshop\.com|tiktok-shops\.com|tiktokcdn\.com)$/.test(
      url.hostname,
    )
  );
}

export type TikTokLabel =
  | { kind: 'ready'; bytes: Uint8Array; tracking: string | undefined; ref: string }
  | { kind: 'pending'; reason: string };

/** Etiqueta do pacote: link do documento → download conferido (PDF, até 5 MB). */
export async function fetchTikTokLabel(
  api: TikTokClient,
  fetchFn: FetchFn,
  packageId: string,
): Promise<TikTokLabel> {
  let doc: Json;
  try {
    doc = await api.get(`/fulfillment/202309/packages/${packageId}/shipping_documents`, {
      document_type: 'SHIPPING_LABEL',
      document_size: 'A6',
    });
  } catch (e) {
    // Pacote ainda sem envio organizado: a TikTok responde com erro de negócio.
    if (
      e instanceof StockPushError &&
      /erro \d+/.test(e.message) &&
      !/reconecte|limite/.test(e.message)
    )
      return { kind: 'pending', reason: 'envio ainda não organizado na TikTok Shop' };
    throw e;
  }
  const url = str(doc.doc_url);
  if (!url) return { kind: 'pending', reason: 'etiqueta ainda não liberada na TikTok Shop' };
  if (!trustedDocumentUrl(url))
    throw new StockPushError('TikTok Shop: endereço da etiqueta inesperado');
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new StockPushError('TikTok Shop: sem resposta ao baixar a etiqueta');
  }
  if (!res.ok) throw new StockPushError(`TikTok Shop: etiqueta HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > LABEL_MAX_BYTES)
    throw new StockPushError('TikTok Shop: etiqueta vazia ou grande demais');
  if (!new TextDecoder().decode(bytes.slice(0, 64)).trimStart().startsWith('%PDF'))
    throw new StockPushError('TikTok Shop: etiqueta em formato inesperado');
  const tracking = str(doc.tracking_number).toUpperCase();
  return {
    kind: 'ready',
    bytes,
    tracking: /^[A-Z0-9-]{4,60}$/.test(tracking) ? tracking : undefined,
    ref: packageId,
  };
}

// ---------------------------------------------------------------------
// Estoque
// ---------------------------------------------------------------------

const REF = /^(\d{1,30}):(\d{1,30}):(\d{1,30})$/;

/** Produto, SKU e depósito pelo SKU do vendedor (busca por seller_skus). */
export async function resolveTikTokSku(api: TikTokClient, sku: string): Promise<string> {
  const found = await api.post(
    '/product/202309/products/search',
    { seller_skus: [sku] },
    { page_size: '10' },
  );
  const matches: string[] = [];
  for (const p of arr(found.products).map(obj)) {
    for (const s of arr(p.skus).map(obj)) {
      if (str(s.seller_sku) !== sku) continue;
      const warehouse = String(obj(arr(s.inventory)[0]).warehouse_id ?? '');
      const ref = `${String(p.id ?? '')}:${String(s.id ?? '')}:${warehouse}`;
      if (REF.test(ref)) matches.push(ref);
    }
  }
  if (matches.length === 0)
    throw new StockPushError(`SKU ${sku} não encontrado na TikTok Shop (ou sem depósito)`);
  if (matches.length > 1)
    throw new StockPushError(`SKU ${sku} em mais de um produto na TikTok Shop`);
  return matches[0]!;
}

/** Define a quantidade do SKU no depósito. Devolve a referência usada (para guardar). */
export async function pushTikTokStock(
  api: TikTokClient,
  args: { sku: string; available: number; ref: string | null },
): Promise<string> {
  const ref = args.ref && REF.test(args.ref) ? args.ref : await resolveTikTokSku(api, args.sku);
  const [, product, skuId, warehouse] = REF.exec(ref)!;
  await api.post(`/product/202309/products/${product}/inventory/update`, {
    skus: [{ id: skuId, inventory: [{ warehouse_id: warehouse, quantity: args.available }] }],
  });
  return ref;
}
