// @vitest-environment node
import {
  SubscriptionShapeError,
  buildPreapprovalBody,
  normalizeAuthorizedPayment,
  normalizePreapproval,
  notificationDataId,
  parseSubscriptionNotification,
} from '../../supabase/functions/_shared/payments/subscriptions';

const subscriptionId = '5b7c2a53-6d4e-4c1b-9f53-0b3f6f0f7a11';

describe('criar assinatura', () => {
  it('mensal, em reais, com o valor do banco e sem cartão', () => {
    expect(
      buildPreapprovalBody({
        subscriptionId,
        planName: 'Pro',
        priceCents: 4990,
        payerEmail: 'dono@example.com',
        backUrl: 'https://app.thesigns.com.br/plano',
      }),
    ).toEqual({
      reason: 'TheSigns — plano Pro',
      external_reference: subscriptionId,
      payer_email: 'dono@example.com',
      back_url: 'https://app.thesigns.com.br/plano',
      status: 'pending',
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: 49.9,
        currency_id: 'BRL',
      },
    });
  });

  it('recusa dados que o Mercado Pago recusaria', () => {
    const base = {
      subscriptionId,
      planName: 'Pro',
      priceCents: 4990,
      payerEmail: 'dono@example.com',
      backUrl: 'https://app/plano',
    };
    expect(() => buildPreapprovalBody({ ...base, priceCents: 50 })).toThrow(SubscriptionShapeError);
    expect(() => buildPreapprovalBody({ ...base, payerEmail: '' })).toThrow('payer_email');
    expect(() => buildPreapprovalBody({ ...base, subscriptionId: 'x' })).toThrow('subscription_id');
  });
});

describe('ler assinatura', () => {
  it('normaliza estado, valor, próxima cobrança e link', () => {
    expect(
      normalizePreapproval({
        id: '2c938084726fca480172750000000000',
        status: 'authorized',
        external_reference: subscriptionId.toUpperCase(),
        auto_recurring: { transaction_amount: 49.9, currency_id: 'BRL' },
        next_payment_date: '2026-11-02T10:00:00.000-04:00',
        init_point: 'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=2c93',
      }),
    ).toEqual({
      external_id: '2c938084726fca480172750000000000',
      external_reference: subscriptionId,
      status: 'authorized',
      amount_cents: 4990,
      next_payment_at: '2026-11-02T14:00:00.000Z',
      checkout_url: 'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=2c93',
    });
  });

  it('finalizada vira cancelada; formato estranho é recusado', () => {
    expect(
      normalizePreapproval({
        id: 'abc',
        status: 'finished',
        auto_recurring: { transaction_amount: '10' },
        init_point: 'http://inseguro',
      }),
    ).toMatchObject({ status: 'cancelled', checkout_url: null, external_reference: null });
    expect(() => normalizePreapproval({ id: 'abc', status: 'weird' })).toThrow(
      SubscriptionShapeError,
    );
    expect(() =>
      normalizePreapproval({ id: 'a/b', status: 'pending', auto_recurring: {} }),
    ).toThrow('id');
  });

  it('cobrança mensal', () => {
    expect(
      normalizeAuthorizedPayment({
        id: 6114264375,
        preapproval_id: '2c93',
        transaction_amount: 49.9,
        status: 'processed',
        debit_date: '2026-10-02T12:00:00Z',
        payment: { id: 123, status: 'approved', status_detail: 'accredited' },
      }),
    ).toEqual({
      external_id: '6114264375',
      preapproval_id: '2c93',
      amount_cents: 4990,
      status: 'processed',
      payment_status: 'approved',
      debit_date: '2026-10-02T12:00:00.000Z',
    });
    expect(() =>
      normalizeAuthorizedPayment({
        id: 1,
        preapproval_id: 'x',
        transaction_amount: 1,
        status: 'x',
      }),
    ).toThrow('status');
  });
});

describe('notificações', () => {
  it('reconhece assinatura, cobrança e pagamento único; ignora o resto', () => {
    expect(
      parseSubscriptionNotification(
        new URLSearchParams('type=subscription_preapproval&data.id=2c93'),
        {},
      ),
    ).toEqual({ kind: 'preapproval', id: '2c93' });
    expect(
      parseSubscriptionNotification(new URLSearchParams(), {
        type: 'subscription_authorized_payment',
        data: { id: '6114264375' },
      }),
    ).toEqual({ kind: 'authorized_payment', id: '6114264375' });
    expect(
      parseSubscriptionNotification(new URLSearchParams('type=payment&data.id=1'), {}),
    ).toEqual({ kind: 'payment', id: '1' });
    expect(
      parseSubscriptionNotification(new URLSearchParams('type=merchant_order&data.id=1'), {}),
    ).toEqual({ kind: 'ignored' });
    expect(
      parseSubscriptionNotification(
        new URLSearchParams('type=subscription_authorized_payment&data.id=abc'),
        {},
      ),
    ).toEqual({ kind: 'ignored' });
    expect(notificationDataId(new URLSearchParams(), { data: { id: 'x1' } })).toBe('x1');
  });
});
