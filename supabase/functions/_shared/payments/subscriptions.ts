/**
 * Assinaturas do Mercado Pago (API /preapproval): código puro, sem Deno e
 * sem rede, usado pela Edge Function `billing` e testado com vitest em
 * `src/integrations/`.
 *
 *  * O valor vem SEMPRE da assinatura gravada no banco (preço do plano no
 *    momento em que o proprietário escolheu), nunca do navegador.
 *  * Sem token de cartão: a assinatura nasce "pending" e o Mercado Pago
 *    devolve o `init_point`, onde o pagador informa o cartão.
 *  * O estado é sempre lido na API; a notificação só diz o que reler.
 */
import { decimalToCents } from '../integrations/common.ts';
import { centsToAmount } from './mercadopago.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREAPPROVAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class SubscriptionShapeError extends Error {}

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;

export interface PreapprovalInput {
  subscriptionId: string;
  planName: string;
  priceCents: number;
  payerEmail: string;
  backUrl: string;
}

/** Corpo do POST /preapproval: mensal, em reais, sem plano associado. */
export function buildPreapprovalBody(input: PreapprovalInput): Record<string, unknown> {
  if (!UUID.test(input.subscriptionId)) throw new SubscriptionShapeError('subscription_id');
  if (!Number.isInteger(input.priceCents) || input.priceCents < 100) {
    throw new SubscriptionShapeError('price_cents');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.payerEmail)) {
    throw new SubscriptionShapeError('payer_email');
  }
  if (!/^https?:\/\//.test(input.backUrl)) throw new SubscriptionShapeError('back_url');
  return {
    reason: `TheSigns — plano ${input.planName}`.slice(0, 120),
    external_reference: input.subscriptionId,
    payer_email: input.payerEmail,
    back_url: input.backUrl,
    status: 'pending',
    auto_recurring: {
      frequency: 1,
      frequency_type: 'months',
      transaction_amount: centsToAmount(input.priceCents),
      currency_id: 'BRL',
    },
  };
}

export type SubscriptionStatus = 'pending' | 'authorized' | 'paused' | 'cancelled';

const statusMap: Record<string, SubscriptionStatus> = {
  pending: 'pending',
  authorized: 'authorized',
  paused: 'paused',
  cancelled: 'cancelled',
  // Fim do período combinado: deixa de cobrar.
  finished: 'cancelled',
};

/** Formato de `billing_sync_subscription`. */
export interface NormalizedPreapproval {
  external_id: string;
  external_reference: string | null;
  status: SubscriptionStatus;
  amount_cents: number;
  next_payment_at: string | null;
  checkout_url: string | null;
}

export function normalizePreapproval(input: unknown): NormalizedPreapproval {
  const p = record(input);
  const id = typeof p.id === 'string' ? p.id : '';
  if (!PREAPPROVAL_ID.test(id)) throw new SubscriptionShapeError('id');
  const status = statusMap[String(p.status)];
  if (!status) throw new SubscriptionShapeError(`status ${String(p.status)}`);
  let amount: number;
  try {
    amount = decimalToCents(record(p.auto_recurring).transaction_amount);
  } catch {
    throw new SubscriptionShapeError('transaction_amount');
  }
  const reference = String(p.external_reference ?? '');
  const initPoint = typeof p.init_point === 'string' ? p.init_point : '';
  return {
    external_id: id,
    external_reference: UUID.test(reference) ? reference.toLowerCase() : null,
    status,
    amount_cents: amount,
    next_payment_at: isoOrNull(p.next_payment_date),
    checkout_url: /^https:\/\//.test(initPoint) && initPoint.length <= 500 ? initPoint : null,
  };
}

export type AuthorizedPaymentStatus = 'scheduled' | 'processed' | 'recycling' | 'cancelled';
const paymentStatuses = new Set<string>(['scheduled', 'processed', 'recycling', 'cancelled']);

/** Formato de `billing_record_payment`. */
export interface NormalizedAuthorizedPayment {
  external_id: string;
  preapproval_id: string;
  amount_cents: number;
  status: AuthorizedPaymentStatus;
  payment_status: string | null;
  debit_date: string | null;
}

/** GET /authorized_payments/:id — uma cobrança mensal da assinatura. */
export function normalizeAuthorizedPayment(input: unknown): NormalizedAuthorizedPayment {
  const p = record(input);
  const id = typeof p.id === 'number' || typeof p.id === 'string' ? String(p.id) : '';
  if (!/^[0-9]{1,30}$/.test(id)) throw new SubscriptionShapeError('id');
  const preapproval = typeof p.preapproval_id === 'string' ? p.preapproval_id : '';
  if (!PREAPPROVAL_ID.test(preapproval)) throw new SubscriptionShapeError('preapproval_id');
  const status = String(p.status);
  if (!paymentStatuses.has(status)) throw new SubscriptionShapeError(`status ${status}`);
  let amount: number;
  try {
    amount = decimalToCents(p.transaction_amount);
  } catch {
    throw new SubscriptionShapeError('transaction_amount');
  }
  const paymentStatus = String(record(p.payment).status ?? '');
  return {
    external_id: id,
    preapproval_id: preapproval,
    amount_cents: amount,
    status: status as AuthorizedPaymentStatus,
    payment_status: /^[a-z_]{1,40}$/.test(paymentStatus) ? paymentStatus : null,
    debit_date: isoOrNull(p.debit_date),
  };
}

export type SubscriptionNotification =
  | { kind: 'preapproval'; id: string }
  | { kind: 'authorized_payment'; id: string }
  // Pagamento único (patrocínio, Fase 43).
  | { kind: 'payment'; id: string }
  | { kind: 'ignored' };

/** Tipo e id de uma notificação (query string ou corpo). */
export function parseSubscriptionNotification(
  params: URLSearchParams,
  body: Record<string, unknown>,
): SubscriptionNotification {
  const type = params.get('type') ?? params.get('topic') ?? String(body.type ?? '');
  const id = params.get('data.id') ?? params.get('id') ?? String(record(body.data).id ?? '');
  if (type === 'subscription_preapproval' && PREAPPROVAL_ID.test(id)) {
    return { kind: 'preapproval', id };
  }
  if (type === 'subscription_authorized_payment' && /^[0-9]{1,30}$/.test(id)) {
    return { kind: 'authorized_payment', id };
  }
  if (type === 'payment' && /^[0-9]{1,30}$/.test(id)) return { kind: 'payment', id };
  return { kind: 'ignored' };
}

/** Id do dado da notificação, para conferir a assinatura `x-signature`. */
export function notificationDataId(params: URLSearchParams, body: Record<string, unknown>): string {
  return params.get('data.id') ?? params.get('id') ?? String(record(body.data).id ?? '');
}
