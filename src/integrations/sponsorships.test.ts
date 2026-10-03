// @vitest-environment node
import {
  SponsorshipShapeError,
  buildPreferenceBody,
  preferenceCheckoutUrl,
} from '../../supabase/functions/_shared/payments/sponsorships';

const campaignId = '5b7c2a53-6d4e-4c1b-9f53-0b3f6f0f7a11';
const base = {
  campaignId,
  title: 'Patrocínio Catálogo 7 dias — Smartwatch',
  priceCents: 2990,
  payerEmail: 'forn@example.com',
  returnUrl: 'https://app.thesigns.com.br/patrocinios',
  notificationUrl: 'https://x.supabase.co/functions/v1/billing/webhook',
};

describe('pagamento do patrocínio', () => {
  it('um item com o valor do banco, volta para a tela e notificação no billing', () => {
    expect(buildPreferenceBody(base)).toEqual({
      items: [
        {
          id: campaignId,
          title: 'Patrocínio Catálogo 7 dias — Smartwatch',
          quantity: 1,
          unit_price: 29.9,
          currency_id: 'BRL',
        },
      ],
      external_reference: campaignId,
      payer: { email: 'forn@example.com' },
      back_urls: {
        success: base.returnUrl,
        pending: base.returnUrl,
        failure: base.returnUrl,
      },
      auto_return: 'approved',
      notification_url: base.notificationUrl,
      statement_descriptor: 'THESIGNS',
    });
    expect(buildPreferenceBody({ ...base, payerEmail: null })).not.toHaveProperty('payer');
  });

  it('recusa dados inválidos e link inseguro', () => {
    expect(() => buildPreferenceBody({ ...base, priceCents: 99 })).toThrow(SponsorshipShapeError);
    expect(() => buildPreferenceBody({ ...base, campaignId: 'x' })).toThrow('campaign_id');
    expect(() => buildPreferenceBody({ ...base, notificationUrl: 'http://x' })).toThrow(
      'notification_url',
    );
    expect(preferenceCheckoutUrl({ init_point: 'https://mp/checkout?pref_id=1' })).toBe(
      'https://mp/checkout?pref_id=1',
    );
    expect(() => preferenceCheckoutUrl({ init_point: 'http://mp' })).toThrow('init_point');
  });
});
