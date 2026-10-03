/**
 * Patrocínios (Fase 43): pagamento único pelo Checkout Pro do Mercado Pago
 * (POST /checkout/preferences). Código puro, testado com vitest em
 * `src/integrations/`.
 *
 *  * Valor e título vêm da compra gravada no banco, nunca do navegador.
 *  * O comprador paga na página do Mercado Pago (PIX, cartão ou boleto); o
 *    resultado chega pela notificação `payment` e é relido na API.
 */
import { centsToAmount } from './mercadopago.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SponsorshipShapeError extends Error {}

export interface PreferenceInput {
  campaignId: string;
  title: string;
  priceCents: number;
  payerEmail: string | null;
  returnUrl: string;
  notificationUrl: string;
}

export function buildPreferenceBody(input: PreferenceInput): Record<string, unknown> {
  if (!UUID.test(input.campaignId)) throw new SponsorshipShapeError('campaign_id');
  if (!Number.isInteger(input.priceCents) || input.priceCents < 100) {
    throw new SponsorshipShapeError('price_cents');
  }
  if (!/^https?:\/\//.test(input.returnUrl)) throw new SponsorshipShapeError('return_url');
  if (!/^https:\/\//.test(input.notificationUrl)) {
    throw new SponsorshipShapeError('notification_url');
  }
  const email =
    input.payerEmail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.payerEmail)
      ? input.payerEmail
      : null;
  return {
    items: [
      {
        id: input.campaignId,
        title: input.title.slice(0, 120) || 'Patrocínio TheSigns',
        quantity: 1,
        unit_price: centsToAmount(input.priceCents),
        currency_id: 'BRL',
      },
    ],
    external_reference: input.campaignId,
    ...(email ? { payer: { email } } : {}),
    back_urls: { success: input.returnUrl, pending: input.returnUrl, failure: input.returnUrl },
    auto_return: 'approved',
    notification_url: input.notificationUrl,
    statement_descriptor: 'THESIGNS',
  };
}

/** Link de pagamento da preferência criada. */
export function preferenceCheckoutUrl(input: unknown): string {
  const p = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const url = typeof p.init_point === 'string' ? p.init_point : '';
  if (!/^https:\/\//.test(url) || url.length > 500) throw new SponsorshipShapeError('init_point');
  return url;
}
