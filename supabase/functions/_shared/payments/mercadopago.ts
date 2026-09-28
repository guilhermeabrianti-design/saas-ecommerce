/**
 * Mercado Pago (API de pagamentos v1): código puro, sem Deno e sem rede,
 * usado pela Edge Function `checkout` e testado com vitest em `src/integrations/`.
 *
 *  * O valor cobrado vem SEMPRE do pedido no banco, nunca do navegador.
 *  * Os dados do cartão ficam no Payment Brick (iframe do Mercado Pago):
 *    aqui só chega o token de uso único.
 *  * O estado do pagamento é sempre lido na API (GET /v1/payments/:id);
 *    a notificação só diz qual pagamento consultar.
 */
import { parseAttribution, type Attribution } from '../affiliates.ts';
import { decimalToCents, timingSafeEqual } from '../integrations/common.ts';

export const MP_API = 'https://api.mercadopago.com';

/** Prazos de pagamento (a reserva de estoque só acontece na aprovação). */
export const PIX_EXPIRATION_MINUTES = 30;
export const BOLETO_EXPIRATION_DAYS = 3;
export const MAX_INSTALLMENTS = 12;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UFS = new Set(
  'AC AL AM AP BA CE DF ES GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO'.split(' '),
);

export class CheckoutInputError extends Error {}

// ---------------------------------------------------------------------
// Comprador
// ---------------------------------------------------------------------

export interface Buyer {
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  customer_document: string;
  ship_postal_code: string;
  ship_street: string;
  ship_number: string;
  ship_complement?: string;
  ship_district: string;
  ship_city: string;
  ship_state: string;
}

const digits = (v: unknown) => (typeof v === 'string' ? v.replace(/\D/g, '') : '');
const text = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

export function isValidCpf(value: string): boolean {
  const d = digits(value);
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  const check = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return check(9) === Number(d[9]) && check(10) === Number(d[10]);
}

function lengthBetween(value: string, min: number, max: number, field: string) {
  if (value.length < min || value.length > max) throw new CheckoutInputError(field);
  return value;
}

/** Valida e limpa os dados do comprador (espelha as regras da tabela de pedidos). */
export function parseBuyer(input: unknown): Buyer {
  if (!input || typeof input !== 'object') throw new CheckoutInputError('buyer');
  const b = input as Record<string, unknown>;
  const email = text(b.customer_email).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
    throw new CheckoutInputError('customer_email');
  }
  const phone = digits(b.customer_phone);
  if (!/^[1-9]{2}(9\d{8}|[2-8]\d{7})$/.test(phone)) throw new CheckoutInputError('customer_phone');
  const document = digits(b.customer_document);
  if (!isValidCpf(document)) throw new CheckoutInputError('customer_document');
  const cep = digits(b.ship_postal_code);
  if (cep.length !== 8) throw new CheckoutInputError('ship_postal_code');
  const state = text(b.ship_state).toUpperCase();
  if (!UFS.has(state)) throw new CheckoutInputError('ship_state');
  const complement = text(b.ship_complement);

  return {
    customer_name: lengthBetween(text(b.customer_name), 2, 120, 'customer_name'),
    customer_email: email,
    customer_phone: phone,
    customer_document: document,
    ship_postal_code: cep,
    ship_street: lengthBetween(text(b.ship_street), 2, 200, 'ship_street'),
    ship_number: lengthBetween(text(b.ship_number), 1, 20, 'ship_number'),
    ...(complement
      ? { ship_complement: lengthBetween(complement, 1, 100, 'ship_complement') }
      : {}),
    ship_district: lengthBetween(text(b.ship_district), 2, 100, 'ship_district'),
    ship_city: lengthBetween(text(b.ship_city), 2, 100, 'ship_city'),
    ship_state: state,
  };
}

// ---------------------------------------------------------------------
// Pedido de pagamento
// ---------------------------------------------------------------------

/** O que o Payment Brick entrega no `onSubmit` (só o que usamos). */
export interface BrickPayment {
  payment_method_id: string;
  token?: string;
  installments?: number;
  issuer_id?: string;
}

export type CheckoutMethod = 'pix' | 'card' | 'boleto';

export interface CheckoutRequest {
  product_id: string;
  variant_id: string | null;
  quantity: number;
  request_id: string;
  buyer: Buyer;
  payment: BrickPayment;
  method: CheckoutMethod;
  /** Por onde o comprador chegou (link ou página da loja); opcional. */
  attribution: Attribution | null;
}

const BOLETO_METHODS = new Set(['bolbradesco', 'pec']);

export function methodOf(paymentMethodId: string): CheckoutMethod {
  if (paymentMethodId === 'pix') return 'pix';
  if (BOLETO_METHODS.has(paymentMethodId)) return 'boleto';
  return 'card';
}

/** Valida o corpo de POST /checkout/pay. */
export function parseCheckoutRequest(input: unknown): CheckoutRequest {
  if (!input || typeof input !== 'object') throw new CheckoutInputError('body');
  const b = input as Record<string, unknown>;
  const productId = String(b.product_id ?? '');
  const variantId = b.variant_id == null ? null : String(b.variant_id);
  const requestId = String(b.request_id ?? '');
  if (
    !UUID.test(productId) ||
    !UUID.test(requestId) ||
    (variantId !== null && !UUID.test(variantId))
  ) {
    throw new CheckoutInputError('ids');
  }
  const quantity = Number(b.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    throw new CheckoutInputError('quantity');
  }

  const p = (b.payment ?? {}) as Record<string, unknown>;
  const paymentMethodId = typeof p.payment_method_id === 'string' ? p.payment_method_id : '';
  if (!/^[a-z0-9_]{2,30}$/.test(paymentMethodId)) throw new CheckoutInputError('payment_method_id');
  const method = methodOf(paymentMethodId);
  const payment: BrickPayment = { payment_method_id: paymentMethodId };
  if (method === 'card') {
    const token = typeof p.token === 'string' ? p.token : '';
    const installments = Number(p.installments);
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(token)) throw new CheckoutInputError('token');
    if (!Number.isInteger(installments) || installments < 1 || installments > MAX_INSTALLMENTS) {
      throw new CheckoutInputError('installments');
    }
    payment.token = token;
    payment.installments = installments;
    if (p.issuer_id != null && String(p.issuer_id) !== '') {
      const issuer = String(p.issuer_id);
      if (!/^[0-9]{1,20}$/.test(issuer)) throw new CheckoutInputError('issuer_id');
      payment.issuer_id = issuer;
    }
  }

  return {
    product_id: productId,
    variant_id: variantId,
    quantity,
    request_id: requestId,
    buyer: parseBuyer(b.buyer),
    payment,
    method,
    attribution: parseAttribution(b.attribution),
  };
}

/** Centavos → número decimal que a API espera (sem erro de ponto flutuante na ida). */
export const centsToAmount = (cents: number) => Math.round(cents) / 100;

/** Data no formato da API (horário de Brasília, que não tem mais horário de verão). */
export function formatMpDate(date: Date): string {
  const local = new Date(date.getTime() - 3 * 3_600_000);
  return `${local.toISOString().slice(0, 23)}-03:00`;
}

function splitName(name: string): { first_name: string; last_name: string } {
  const parts = name.trim().split(/\s+/);
  const first = parts.shift() ?? name;
  return { first_name: first, last_name: parts.join(' ') || first };
}

export interface OrderForPayment {
  order_id: string;
  total_cents: number;
  description: string;
}

/** Corpo de POST /v1/payments. */
export function buildPaymentBody(
  req: CheckoutRequest,
  order: OrderForPayment,
  notificationUrl: string,
  now: Date = new Date(),
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    transaction_amount: centsToAmount(order.total_cents),
    description: order.description.slice(0, 120),
    payment_method_id: req.payment.payment_method_id,
    external_reference: order.order_id,
    notification_url: notificationUrl,
    payer: {
      email: req.buyer.customer_email,
      ...splitName(req.buyer.customer_name),
      identification: { type: 'CPF', number: req.buyer.customer_document },
      ...(req.method === 'boleto'
        ? {
            address: {
              zip_code: req.buyer.ship_postal_code,
              street_name: req.buyer.ship_street,
              street_number: req.buyer.ship_number,
              neighborhood: req.buyer.ship_district,
              city: req.buyer.ship_city,
              federal_unit: req.buyer.ship_state,
            },
          }
        : {}),
    },
  };
  if (req.method === 'card') {
    body.token = req.payment.token;
    body.installments = req.payment.installments;
    if (req.payment.issuer_id) body.issuer_id = req.payment.issuer_id;
  } else {
    const ms =
      req.method === 'pix' ? PIX_EXPIRATION_MINUTES * 60_000 : BOLETO_EXPIRATION_DAYS * 86_400_000;
    body.date_of_expiration = formatMpDate(new Date(now.getTime() + ms));
  }
  return body;
}

// ---------------------------------------------------------------------
// Resposta da API → formato de `checkout_sync_payment`
// ---------------------------------------------------------------------

export type PaymentStatus =
  'pending' | 'approved' | 'rejected' | 'cancelled' | 'refunded' | 'charged_back';

const statusMap: Record<string, PaymentStatus> = {
  pending: 'pending',
  in_process: 'pending',
  in_mediation: 'pending',
  authorized: 'pending',
  approved: 'approved',
  rejected: 'rejected',
  cancelled: 'cancelled',
  refunded: 'refunded',
  charged_back: 'charged_back',
};

export interface NormalizedPayment {
  external_id: string;
  external_reference: string | null;
  status: PaymentStatus;
  status_detail: string | null;
  method: CheckoutMethod | null;
  amount_cents: number;
  fee_cents: number;
  pix_qr_code: string | null;
  pix_qr_base64: string | null;
  boleto_url: string | null;
  expires_at: string | null;
}

export class PaymentShapeError extends Error {}

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

export function normalizePayment(input: unknown): NormalizedPayment {
  const p = record(input);
  const id = typeof p.id === 'number' || typeof p.id === 'string' ? String(p.id) : '';
  if (!/^[0-9]{1,30}$/.test(id)) throw new PaymentShapeError('id');
  const status = statusMap[String(p.status)];
  if (!status) throw new PaymentShapeError(`status ${String(p.status)}`);

  let amount: number;
  try {
    amount = decimalToCents(p.transaction_amount);
  } catch {
    throw new PaymentShapeError('transaction_amount');
  }

  // Taxas pagas pela plataforma (quem recebe); juros do parcelamento pagos pelo comprador ficam fora.
  let fee = 0;
  for (const f of Array.isArray(p.fee_details) ? p.fee_details : []) {
    const detail = record(f);
    if (detail.fee_payer === 'payer') continue;
    try {
      fee += decimalToCents(detail.amount);
    } catch {
      throw new PaymentShapeError('fee_details');
    }
  }

  const type = String(p.payment_type_id ?? '');
  const methodId = String(p.payment_method_id ?? '');
  const method: CheckoutMethod | null =
    methodId === 'pix'
      ? 'pix'
      : type === 'ticket'
        ? 'boleto'
        : ['credit_card', 'debit_card', 'prepaid_card'].includes(type)
          ? 'card'
          : null;

  const tx = record(record(p.point_of_interaction).transaction_data);
  const boletoUrl = String(record(p.transaction_details).external_resource_url ?? '');
  const reference = String(p.external_reference ?? '');
  const qr = typeof tx.qr_code === 'string' && tx.qr_code.length <= 1000 ? tx.qr_code : null;
  const qr64 =
    typeof tx.qr_code_base64 === 'string' && tx.qr_code_base64.length <= 60000
      ? tx.qr_code_base64
      : null;
  const expires = typeof p.date_of_expiration === 'string' ? p.date_of_expiration : null;

  return {
    external_id: id,
    external_reference: UUID.test(reference) ? reference.toLowerCase() : null,
    status,
    status_detail: typeof p.status_detail === 'string' ? p.status_detail.slice(0, 120) : null,
    method,
    amount_cents: amount,
    fee_cents: fee,
    pix_qr_code: qr,
    pix_qr_base64: qr64,
    boleto_url: /^https:\/\//.test(boletoUrl) && boletoUrl.length <= 500 ? boletoUrl : null,
    expires_at: expires && !Number.isNaN(Date.parse(expires)) ? expires : null,
  };
}

// ---------------------------------------------------------------------
// Notificações (webhook)
// ---------------------------------------------------------------------

export async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `x-signature: ts=1704908010,v1=<hex>` → partes. */
export function parseSignatureHeader(header: string | null): { ts: string; v1: string } | null {
  if (!header) return null;
  let ts = '';
  let v1 = '';
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2).map((s) => s.trim());
    if (k === 'ts') ts = v ?? '';
    if (k === 'v1') v1 = v ?? '';
  }
  return /^[0-9]{1,20}$/.test(ts) && /^[0-9a-f]{64}$/i.test(v1)
    ? { ts, v1: v1.toLowerCase() }
    : null;
}

/** Texto assinado pelo Mercado Pago; partes ausentes na notificação saem do modelo. */
export function signatureManifest(
  dataId: string | null,
  requestId: string | null,
  ts: string,
): string {
  let manifest = '';
  if (dataId) manifest += `id:${/^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId};`;
  if (requestId) manifest += `request-id:${requestId};`;
  return `${manifest}ts:${ts};`;
}

/**
 * Sem limite de idade do `ts`: o Mercado Pago reenvia notificações por horas,
 * e repetir uma notificação só faz reler o pagamento na API (idempotente).
 */
export async function verifyWebhookSignature(
  secret: string,
  header: string | null,
  requestId: string | null,
  dataId: string | null,
): Promise<boolean> {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  const expected = await hmacHex(secret, signatureManifest(dataId, requestId, parsed.ts));
  return timingSafeEqual(expected, parsed.v1);
}
