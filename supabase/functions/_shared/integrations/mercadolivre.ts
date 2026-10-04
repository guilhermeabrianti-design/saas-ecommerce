import {
  NormalizeError,
  cleanDocument,
  cleanPhone,
  compact,
  decimalToCents,
  onlyDigits,
  str,
  type NormalizeResult,
} from './common.ts';
import { StockPushError, type FetchFn } from './stock.ts';

/**
 * Mercado Livre (Fase 31): código puro usado pelas Edge Functions
 * `mercadolivre` e `stock-sync`, testado com vitest em `src/integrations/`.
 *
 * ATENÇÃO: formatos conforme a documentação pública (OAuth 2.0 com PKCE,
 * orders_v2, shipments, items). NÃO exercitado contra contas reais nesta
 * entrega: valide com um usuário de teste do Mercado Livre antes de
 * produção.
 */

export const ML_AUTH_URL = 'https://auth.mercadolivre.com.br/authorization';
export const ML_API = 'https://api.mercadolibre.com';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

// ---------------------------------------------------------------------
// OAuth 2.0 + PKCE
// ---------------------------------------------------------------------

/** code_verifier aleatório (43–128 caracteres, RFC 7636). */
export function generateCodeVerifier(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(48)));
}

export async function codeChallenge(verifier: string): Promise<string> {
  return b64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
}

export function authorizationUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    state: args.state,
    code_challenge: args.challenge,
    code_challenge_method: 'S256',
  });
  return `${ML_AUTH_URL}?${q.toString()}`;
}

export interface MlTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user_id: string;
}

/** Resposta de POST /oauth/token (código ou renovação). */
export function parseTokenResponse(body: unknown): MlTokens {
  const b = obj(body);
  const access = str(b.access_token);
  const refresh = str(b.refresh_token);
  const expires = Number(b.expires_in);
  const user = String(b.user_id ?? '');
  if (
    !access ||
    !refresh ||
    !Number.isFinite(expires) ||
    expires <= 0 ||
    !/^\d{1,20}$/.test(user)
  ) {
    throw new StockPushError('Mercado Livre: resposta de token inválida');
  }
  return { access_token: access, refresh_token: refresh, expires_in: expires, user_id: user };
}

export const expiresAt = (now: Date, expiresIn: number) =>
  new Date(now.getTime() + expiresIn * 1000).toISOString();

/** Renova com 5 minutos de folga. */
export const needsRefresh = (expires: string | undefined, now: Date) =>
  !expires || new Date(expires).getTime() - now.getTime() < 5 * 60_000;

export interface StoredMlCredentials {
  secret: { access_token: string; refresh_token: string };
  config: { token_version?: number; expires_at?: string; user_id?: string };
}

/**
 * Token de acesso válido, renovando quando preciso. As funções de leitura,
 * gravação (com versão esperada) e troca são injetadas. Se outro processo
 * renovou antes (gravação recusada ou token de renovação já usado), relê.
 */
export async function getAccessToken(deps: {
  read: () => Promise<StoredMlCredentials>;
  swap: (expectedVersion: number, next: StoredMlCredentials) => Promise<boolean>;
  refresh: (refreshToken: string) => Promise<MlTokens>;
  now?: () => Date;
}): Promise<string> {
  const now = deps.now ?? (() => new Date());
  const current = await deps.read();
  if (!needsRefresh(current.config.expires_at, now())) return current.secret.access_token;

  const version = current.config.token_version ?? 0;
  let tokens: MlTokens;
  try {
    tokens = await deps.refresh(current.secret.refresh_token);
  } catch (e) {
    // Token de renovação já consumido por outra renovação: vale a gravada.
    const latest = await deps.read();
    if (
      (latest.config.token_version ?? 0) !== version &&
      !needsRefresh(latest.config.expires_at, now())
    ) {
      return latest.secret.access_token;
    }
    throw e instanceof StockPushError
      ? e
      : new StockPushError('Não foi possível renovar o acesso ao marketplace (reconecte a conta)');
  }
  const next: StoredMlCredentials = {
    secret: { access_token: tokens.access_token, refresh_token: tokens.refresh_token },
    config: {
      ...current.config,
      token_version: version + 1,
      expires_at: expiresAt(now(), tokens.expires_in),
    },
  };
  if (await deps.swap(version, next)) return tokens.access_token;
  const latest = await deps.read();
  return latest.secret.access_token;
}

// ---------------------------------------------------------------------
// Notificações e pedidos
// ---------------------------------------------------------------------

export interface MlNotification {
  topic: 'orders_v2' | 'shipments';
  resourceId: string;
  userId: string;
}

const TOPIC_RESOURCE = {
  orders_v2: /^\/orders\/(\d{1,20})$/,
  shipments: /^\/shipments\/(\d{1,20})$/,
};

/**
 * Notificação do Mercado Livre (sem assinatura: o recurso é relido na API).
 * Pedidos (orders_v2) e envios (shipments: etiqueta liberada, nota anexada).
 */
export function parseNotification(body: unknown, applicationId: string): MlNotification | null {
  const b = obj(body);
  if (String(b.application_id ?? '') !== applicationId) return null;
  const topic = str(b.topic);
  const userId = String(b.user_id ?? '');
  if (topic !== 'orders_v2' && topic !== 'shipments') return null;
  const m = TOPIC_RESOURCE[topic].exec(str(b.resource));
  if (!m || !/^\d{1,20}$/.test(userId)) return null;
  return { topic, resourceId: m[1]!, userId };
}

const UF = /^BR-([A-Z]{2})$/;

/**
 * Pedido (GET /orders/:id) + envio (GET /shipments/:id, formato novo) →
 * pedido normalizado. Pagos entram; Full (enviado pelo Mercado Livre),
 * sem envio, cancelados e aguardando pagamento são ignorados.
 */
export function normalizeMercadoLivreOrder(order: unknown, shipment: unknown): NormalizeResult {
  const o = obj(order);
  const id = o.id;
  if ((typeof id !== 'number' && typeof id !== 'string') || String(id) === '') {
    throw new NormalizeError('pedido sem id');
  }
  const status = str(o.status);
  if (status === 'cancelled' || status === 'invalid')
    return { kind: 'skip', reason: `pedido ${status}` };
  if (status !== 'paid')
    return { kind: 'skip', reason: `aguardando pagamento (${status || 'sem status'})` };

  const items = arr(o.order_items).map((raw) => {
    const li = obj(raw);
    const item = obj(li.item);
    const sku = str(item.seller_sku) || str(item.seller_custom_field);
    const external =
      sku ||
      (item.variation_id
        ? `variation:${String(item.variation_id)}`
        : item.id
          ? `item:${String(item.id)}`
          : '');
    if (!external) throw new NormalizeError('item sem SKU nem id');
    const quantity = Number(li.quantity);
    if (!Number.isInteger(quantity) || quantity < 1)
      throw new NormalizeError('quantidade inválida');
    return {
      external_item_id: external,
      quantity,
      unit_price_cents: decimalToCents(String(li.unit_price)),
    };
  });
  if (items.length === 0) throw new NormalizeError('pedido sem itens');

  const s = obj(shipment);
  if (!Object.keys(s).length)
    return { kind: 'skip', reason: 'pedido sem envio (retirada ou a combinar)' };
  if (str(s.logistic_type) === 'fulfillment') {
    return { kind: 'skip', reason: 'Mercado Envios Full: enviado pelo Mercado Livre' };
  }
  const dest = obj(obj(s.destination).shipping_address);
  const addr = Object.keys(dest).length ? dest : obj(s.receiver_address);
  const receiver = obj(s.destination);
  const buyer = obj(o.buyer);
  const name =
    str(receiver.receiver_name) ||
    str(addr.receiver_name) ||
    `${str(buyer.first_name)} ${str(buyer.last_name)}`.trim() ||
    str(buyer.nickname);
  const state = UF.exec(str(obj(addr.state).id))?.[1] ?? str(obj(addr.state).id).toUpperCase();
  const cost = obj(s.lead_time).cost ?? obj(s.shipping_option).cost;

  return {
    kind: 'order',
    externalId: String(id),
    order: compact({
      customer_name: name,
      customer_phone: cleanPhone(receiver.receiver_phone) ?? cleanPhone(addr.receiver_phone),
      customer_document: cleanDocument(obj(buyer.billing_info).doc_number),
      ship_postal_code: onlyDigits(addr.zip_code),
      ship_street: str(addr.street_name),
      ship_number: str(addr.street_number) || 'S/N',
      ship_complement: str(addr.comment) || undefined,
      ship_district: str(obj(addr.neighborhood).name) || 'Não informado',
      ship_city: str(obj(addr.city).name),
      ship_state: state,
      shipping_cents: cost == null ? 0 : decimalToCents(String(cost)),
      discount_cents: 0,
      notes: `Mercado Livre #${String(id)}${o.pack_id ? ` (pacote ${String(o.pack_id)})` : ''}`,
      items,
    }),
  };
}

// ---------------------------------------------------------------------
// Estoque
// ---------------------------------------------------------------------

async function call(fetchFn: FetchFn, url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new StockPushError('Mercado Livre: sem resposta (rede ou tempo esgotado)');
  }
  if (res.status === 401 || res.status === 403)
    throw new StockPushError('Mercado Livre: acesso recusado (reconecte a conta)');
  if (res.status === 429) throw new StockPushError('Mercado Livre: limite de requisições');
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = str(obj(body).message);
    throw new StockPushError(
      `Mercado Livre: HTTP ${res.status}${message ? ` — ${message.slice(0, 200)}` : ''}`,
    );
  }
  return body;
}

/** Leitura autenticada na API (pedido, envio). */
export const mlGet = (
  fetchFn: FetchFn,
  accessToken: string,
  path: string,
  extra: Record<string, string> = {},
) =>
  call(fetchFn, `${ML_API}${path}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}`, ...extra },
  });

// ---------------------------------------------------------------------
// Documentos do envio: etiqueta e nota fiscal (Fase 32)
// ---------------------------------------------------------------------

export const DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;

export type MlDocumentKind = 'label' | 'invoice_pdf' | 'invoice_xml';

export interface MlDocument {
  kind: MlDocumentKind;
  /** Identificador no Mercado Livre (envio ou nota): deduplica no banco. */
  ref: string;
  path: string;
  accept: string;
  extension: 'pdf' | 'xml';
  fileName: string;
  contentType: 'application/pdf' | 'application/xml';
  tracking?: string;
}

/** Só caminhos de nota do próprio usuário na API (nada de URL arbitrária). */
const INVOICE_PATH = /^\/users\/\d{1,20}\/invoices\/[A-Za-z0-9/_-]{1,200}$/;

/** Etiqueta pode ser impressa: pronto para envio, aguardando impressão ou já impressa. */
export function labelReady(shipment: unknown): boolean {
  const s = obj(shipment);
  return (
    str(s.status) === 'ready_to_ship' && ['ready_to_print', 'printed'].includes(str(s.substatus))
  );
}

const cleanTracking = (v: unknown) => {
  const t = str(v).toUpperCase();
  return /^[A-Z0-9-]{4,60}$/.test(t) ? t : undefined;
};

/**
 * Documentos disponíveis para o envio:
 *  - etiqueta (GET /shipment_labels, PDF) quando liberada para impressão;
 *  - nota fiscal do Faturador (GET /users/:id/invoices/orders/:order) quando
 *    autorizada: DANFE (PDF) e XML.
 * `invoice` é a resposta da nota (ou nulo quando não há nota no Mercado Livre).
 */
export function availableDocuments(args: {
  shipmentId: string | null;
  shipment: unknown;
  invoice: unknown;
}): MlDocument[] {
  const docs: MlDocument[] = [];
  if (args.shipmentId && /^\d{1,20}$/.test(args.shipmentId) && labelReady(args.shipment)) {
    docs.push({
      kind: 'label',
      ref: args.shipmentId,
      path: `/shipment_labels?shipment_ids=${args.shipmentId}&response_type=pdf`,
      accept: 'application/pdf',
      extension: 'pdf',
      fileName: `etiqueta-mercado-livre-${args.shipmentId}.pdf`,
      contentType: 'application/pdf',
      tracking: cleanTracking(obj(args.shipment).tracking_number),
    });
  }

  const inv = obj(args.invoice);
  const id = String(inv.id ?? '');
  if (str(inv.status).toLowerCase() === 'authorized' && /^[A-Za-z0-9_-]{1,60}$/.test(id)) {
    const attrs = obj(inv.attributes);
    const number = String(inv.invoice_number ?? id).replace(/[^0-9A-Za-z-]/g, '') || id;
    const danfe = str(attrs.danfe_location);
    const xml = str(attrs.xml_location);
    if (INVOICE_PATH.test(danfe)) {
      docs.push({
        kind: 'invoice_pdf',
        ref: id,
        path: danfe,
        accept: 'application/pdf',
        extension: 'pdf',
        fileName: `nota-fiscal-${number}.pdf`,
        contentType: 'application/pdf',
      });
    }
    if (INVOICE_PATH.test(xml)) {
      docs.push({
        kind: 'invoice_xml',
        ref: id,
        path: xml,
        accept: 'application/xml',
        extension: 'xml',
        fileName: `nota-fiscal-${number}.xml`,
        contentType: 'application/xml',
      });
    }
  }
  return docs;
}

/** Nota da venda no Faturador; 404 = sem nota emitida pelo Mercado Livre. */
export async function fetchOrderInvoice(
  fetchFn: FetchFn,
  accessToken: string,
  userId: string,
  orderId: string,
): Promise<unknown> {
  if (!/^\d{1,20}$/.test(userId) || !/^\d{1,20}$/.test(orderId)) return null;
  let res: Response;
  try {
    res = await fetchFn(`${ML_API}/users/${userId}/invoices/orders/${orderId}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new StockPushError('Mercado Livre: sem resposta (rede ou tempo esgotado)');
  }
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403)
    throw new StockPushError('Mercado Livre: acesso recusado à nota fiscal');
  if (!res.ok) throw new StockPushError(`Mercado Livre: nota fiscal HTTP ${res.status}`);
  return res.json().catch(() => null);
}

/** Baixa um documento conferindo o formato (PDF começa com %PDF, XML com <) e o tamanho. */
export async function downloadDocument(
  fetchFn: FetchFn,
  accessToken: string,
  doc: MlDocument,
): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetchFn(`${ML_API}${doc.path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}`, accept: doc.accept },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new StockPushError('Mercado Livre: sem resposta ao baixar o documento');
  }
  if (!res.ok) throw new StockPushError(`Mercado Livre: documento HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > DOCUMENT_MAX_BYTES)
    throw new StockPushError('Mercado Livre: documento vazio ou grande demais');
  const head = new TextDecoder().decode(bytes.slice(0, 64)).trimStart();
  const ok = doc.extension === 'pdf' ? head.startsWith('%PDF') : head.startsWith('<');
  if (!ok) throw new StockPushError('Mercado Livre: documento em formato inesperado');
  return bytes;
}

const skuOf = (v: Json) =>
  str(v.seller_custom_field) ||
  str(
    obj(
      arr(v.attributes)
        .map(obj)
        .find((a) => a.id === 'SELLER_SKU'),
    ).value_name,
  );

/** Acha o anúncio pelo SKU do vendedor e define a quantidade disponível (anúncio ou variação). */
export async function pushMercadoLivreStock(
  fetchFn: FetchFn,
  args: { accessToken: string; userId: string; sku: string; available: number },
): Promise<void> {
  const headers = {
    authorization: `Bearer ${args.accessToken}`,
    'content-type': 'application/json',
  };
  const found = obj(
    await call(
      fetchFn,
      `${ML_API}/users/${encodeURIComponent(args.userId)}/items/search?seller_sku=${encodeURIComponent(args.sku)}`,
      { method: 'GET', headers },
    ),
  );
  const ids = arr(found.results).map(String);
  if (ids.length === 0) throw new StockPushError(`SKU ${args.sku} não encontrado no Mercado Livre`);
  if (ids.length > 1)
    throw new StockPushError(`SKU ${args.sku} em mais de um anúncio no Mercado Livre`);
  const id = ids[0]!;
  const item = obj(
    await call(fetchFn, `${ML_API}/items/${encodeURIComponent(id)}?include_attributes=all`, {
      method: 'GET',
      headers,
    }),
  );
  const variations = arr(item.variations).map(obj);
  let body: Json;
  if (variations.length) {
    const variation = variations.find((v) => skuOf(v) === args.sku);
    if (!variation)
      throw new StockPushError(`SKU ${args.sku}: variação não encontrada no anúncio ${id}`);
    body = { variations: [{ id: variation.id, available_quantity: args.available }] };
  } else {
    body = { available_quantity: args.available };
  }
  await call(fetchFn, `${ML_API}/items/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  });
}
