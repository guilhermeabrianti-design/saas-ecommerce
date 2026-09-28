// @vitest-environment node
import {
  CheckoutInputError,
  PaymentShapeError,
  buildPaymentBody,
  centsToAmount,
  formatMpDate,
  hmacHex,
  methodOf,
  normalizePayment,
  parseBuyer,
  parseCheckoutRequest,
  parseSignatureHeader,
  signatureManifest,
  verifyWebhookSignature,
} from '../../supabase/functions/_shared/payments/mercadopago';

const buyer = {
  customer_name: '  Maria   da Silva ',
  customer_email: 'Maria@Example.com ',
  customer_phone: '(11) 98765-4321',
  customer_document: '123.456.789-09',
  ship_postal_code: '01310-100',
  ship_street: 'Av. Paulista',
  ship_number: '1000',
  ship_complement: '',
  ship_district: 'Bela Vista',
  ship_city: 'São Paulo',
  ship_state: 'sp',
};

const ids = {
  product_id: '5b7c2a53-6d4e-4c1b-9f53-0b3f6f0f7a11',
  variant_id: '7c9d3b64-7e5f-4d2c-8a64-1c4a7a1a8b22',
  request_id: '9e1f5d86-9a7b-4f4e-8c86-3e6c9c3cad44',
};

describe('comprador', () => {
  it('limpa e valida os dados', () => {
    expect(parseBuyer(buyer)).toEqual({
      customer_name: 'Maria da Silva',
      customer_email: 'maria@example.com',
      customer_phone: '11987654321',
      customer_document: '12345678909',
      ship_postal_code: '01310100',
      ship_street: 'Av. Paulista',
      ship_number: '1000',
      ship_district: 'Bela Vista',
      ship_city: 'São Paulo',
      ship_state: 'SP',
    });
  });

  it('aponta o campo inválido', () => {
    const bad: [string, unknown][] = [
      ['customer_email', 'sem-arroba'],
      ['customer_phone', '1234'],
      ['customer_document', '111.111.111-11'],
      ['customer_document', '123.456.789-00'],
      ['ship_postal_code', '0131'],
      ['ship_state', 'XX'],
      ['customer_name', 'M'],
      ['ship_number', ''],
    ];
    for (const [field, value] of bad) {
      expect(() => parseBuyer({ ...buyer, [field]: value })).toThrow(new CheckoutInputError(field));
    }
    expect(() => parseBuyer(null)).toThrow(CheckoutInputError);
  });
});

describe('pedido de pagamento', () => {
  const base = { ...ids, quantity: 2, buyer };

  it('identifica o meio pelo id do Mercado Pago', () => {
    expect(methodOf('pix')).toBe('pix');
    expect(methodOf('bolbradesco')).toBe('boleto');
    expect(methodOf('pec')).toBe('boleto');
    expect(methodOf('master')).toBe('card');
  });

  it('cartão exige token e parcelas; PIX e boleto não', () => {
    const card = parseCheckoutRequest({
      ...base,
      payment: { payment_method_id: 'visa', token: 'abcdef123456', installments: 3, issuer_id: 24 },
    });
    expect(card).toMatchObject({
      method: 'card',
      quantity: 2,
      payment: {
        payment_method_id: 'visa',
        token: 'abcdef123456',
        installments: 3,
        issuer_id: '24',
      },
    });
    expect(() =>
      parseCheckoutRequest({ ...base, payment: { payment_method_id: 'visa', installments: 1 } }),
    ).toThrow(new CheckoutInputError('token'));
    expect(() =>
      parseCheckoutRequest({
        ...base,
        payment: { payment_method_id: 'visa', token: 'abcdef123456', installments: 13 },
      }),
    ).toThrow(new CheckoutInputError('installments'));

    // Campos extras do navegador (inclusive valor) são ignorados.
    const pix = parseCheckoutRequest({
      ...base,
      variant_id: null,
      payment: { payment_method_id: 'pix', token: 'x', transaction_amount: 0.01 },
    });
    expect(pix.payment).toEqual({ payment_method_id: 'pix' });
    expect(pix.variant_id).toBeNull();
  });

  it('recusa ids, quantidade e meio inválidos', () => {
    const pix = { payment_method_id: 'pix' };
    expect(() => parseCheckoutRequest({ ...base, product_id: '1', payment: pix })).toThrow(
      new CheckoutInputError('ids'),
    );
    expect(() => parseCheckoutRequest({ ...base, quantity: 0, payment: pix })).toThrow(
      new CheckoutInputError('quantity'),
    );
    expect(() => parseCheckoutRequest({ ...base, quantity: 1.5, payment: pix })).toThrow(
      new CheckoutInputError('quantity'),
    );
    expect(() =>
      parseCheckoutRequest({ ...base, payment: { payment_method_id: 'PIX; drop' } }),
    ).toThrow(new CheckoutInputError('payment_method_id'));
  });

  it('valor vem do pedido; PIX vence em 30 min, boleto em 3 dias, com endereço', () => {
    const now = new Date('2026-09-28T15:00:00Z');
    const order = { order_id: ids.request_id, total_cents: 11980, description: 'Camiseta' };
    const url = 'https://x.supabase.co/functions/v1/checkout/webhook';

    const pix = buildPaymentBody(
      parseCheckoutRequest({ ...base, payment: { payment_method_id: 'pix' } }),
      order,
      url,
      now,
    );
    expect(pix).toEqual({
      transaction_amount: 119.8,
      description: 'Camiseta',
      payment_method_id: 'pix',
      external_reference: ids.request_id,
      notification_url: url,
      payer: {
        email: 'maria@example.com',
        first_name: 'Maria',
        last_name: 'da Silva',
        identification: { type: 'CPF', number: '12345678909' },
      },
      date_of_expiration: '2026-09-28T12:30:00.000-03:00',
    });

    const boleto = buildPaymentBody(
      parseCheckoutRequest({ ...base, payment: { payment_method_id: 'bolbradesco' } }),
      order,
      url,
      now,
    );
    expect(boleto.date_of_expiration).toBe('2026-10-01T12:00:00.000-03:00');
    expect((boleto.payer as Record<string, unknown>).address).toEqual({
      zip_code: '01310100',
      street_name: 'Av. Paulista',
      street_number: '1000',
      neighborhood: 'Bela Vista',
      city: 'São Paulo',
      federal_unit: 'SP',
    });

    const card = buildPaymentBody(
      parseCheckoutRequest({
        ...base,
        payment: { payment_method_id: 'master', token: 'tok_123456789', installments: 2 },
      }),
      order,
      url,
      now,
    );
    expect(card).toMatchObject({ token: 'tok_123456789', installments: 2 });
    expect(card).not.toHaveProperty('date_of_expiration');
    expect(card).not.toHaveProperty('issuer_id');
  });

  it('centavos viram decimal exato e datas saem no horário de Brasília', () => {
    expect(centsToAmount(5990)).toBe(59.9);
    expect(centsToAmount(1)).toBe(0.01);
    expect(centsToAmount(10)).toBe(0.1);
    expect(formatMpDate(new Date('2026-01-01T02:00:00Z'))).toBe('2025-12-31T23:00:00.000-03:00');
  });
});

describe('resposta do Mercado Pago', () => {
  const pixPending = {
    id: 1319447396,
    status: 'pending',
    status_detail: 'pending_waiting_transfer',
    payment_method_id: 'pix',
    payment_type_id: 'bank_transfer',
    transaction_amount: 59.9,
    external_reference: ids.request_id.toUpperCase(),
    date_of_expiration: '2026-09-28T12:30:00.000-04:00',
    fee_details: [],
    point_of_interaction: {
      transaction_data: { qr_code: '00020126580014br.gov.bcb.pix', qr_code_base64: 'iVBORw0KGgo=' },
    },
  };

  it('PIX pendente traz o código e a imagem', () => {
    expect(normalizePayment(pixPending)).toEqual({
      external_id: '1319447396',
      external_reference: ids.request_id,
      status: 'pending',
      status_detail: 'pending_waiting_transfer',
      method: 'pix',
      amount_cents: 5990,
      fee_cents: 0,
      pix_qr_code: '00020126580014br.gov.bcb.pix',
      pix_qr_base64: 'iVBORw0KGgo=',
      boleto_url: null,
      expires_at: '2026-09-28T12:30:00.000-04:00',
    });
  });

  it('taxa = só o que a plataforma paga (juros do comprador ficam fora)', () => {
    const card = normalizePayment({
      id: '42',
      status: 'approved',
      status_detail: 'accredited',
      payment_method_id: 'master',
      payment_type_id: 'credit_card',
      transaction_amount: 100,
      fee_details: [
        { type: 'mercadopago_fee', fee_payer: 'collector', amount: 4.99 },
        { type: 'financing_fee', fee_payer: 'payer', amount: 7.5 },
        { type: 'application_fee', fee_payer: 'collector', amount: '0.51' },
      ],
    });
    expect(card).toMatchObject({
      method: 'card',
      amount_cents: 10000,
      fee_cents: 550,
      status: 'approved',
    });
  });

  it('boleto, estados intermediários e referência que não é nossa', () => {
    const boleto = normalizePayment({
      id: 7,
      status: 'in_process',
      payment_method_id: 'bolbradesco',
      payment_type_id: 'ticket',
      transaction_amount: '10.50',
      external_reference: 'pedido-123',
      transaction_details: { external_resource_url: 'https://www.mercadopago.com.br/boleto/7' },
    });
    expect(boleto).toMatchObject({
      status: 'pending',
      method: 'boleto',
      amount_cents: 1050,
      external_reference: null,
      boleto_url: 'https://www.mercadopago.com.br/boleto/7',
    });
    expect(
      normalizePayment({
        id: 8,
        status: 'charged_back',
        transaction_amount: 1,
        transaction_details: { external_resource_url: 'http://inseguro' },
      }),
    ).toMatchObject({ status: 'charged_back', method: null, boleto_url: null });
  });

  it('formato inesperado é erro (não vira pagamento)', () => {
    expect(() => normalizePayment({ status: 'approved', transaction_amount: 1 })).toThrow(
      PaymentShapeError,
    );
    expect(() => normalizePayment({ id: 1, status: 'weird', transaction_amount: 1 })).toThrow(
      PaymentShapeError,
    );
    expect(() =>
      normalizePayment({ id: 1, status: 'approved', transaction_amount: 'abc' }),
    ).toThrow(PaymentShapeError);
    expect(() => normalizePayment(null)).toThrow(PaymentShapeError);
  });
});

describe('assinatura das notificações', () => {
  const secret = 'segredo-de-teste';

  it('lê o cabeçalho e monta o texto assinado', () => {
    const v1 = 'a'.repeat(64);
    expect(parseSignatureHeader(`ts=1704908010, v1=${v1.toUpperCase()}`)).toEqual({
      ts: '1704908010',
      v1,
    });
    expect(parseSignatureHeader('ts=abc,v1=123')).toBeNull();
    expect(parseSignatureHeader(null)).toBeNull();
    expect(signatureManifest('ABC123', 'req-1', '1704908010')).toBe(
      'id:abc123;request-id:req-1;ts:1704908010;',
    );
    expect(signatureManifest(null, null, '1')).toBe('ts:1;');
  });

  it('aceita a assinatura certa e recusa qualquer alteração', async () => {
    const ts = '1704908010';
    const v1 = await hmacHex(secret, `id:123;request-id:req-1;ts:${ts};`);
    const header = `ts=${ts},v1=${v1}`;
    expect(await verifyWebhookSignature(secret, header, 'req-1', '123')).toBe(true);
    expect(await verifyWebhookSignature(secret, header, 'req-1', '124')).toBe(false);
    expect(await verifyWebhookSignature(secret, header, 'req-2', '123')).toBe(false);
    expect(await verifyWebhookSignature('outro', header, 'req-1', '123')).toBe(false);
    expect(await verifyWebhookSignature(secret, null, 'req-1', '123')).toBe(false);
  });

  it('HMAC-SHA256 em hexadecimal (vetor conhecido)', async () => {
    // RFC 4231, caso 2.
    expect(await hmacHex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });
});
