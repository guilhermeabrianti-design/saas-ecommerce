// @vitest-environment node
import {
  NormalizeError,
  decimalToCents,
  hmacBase64,
  splitStreet,
  timingSafeEqual,
  verifySignature,
} from '../../supabase/functions/_shared/integrations/common';
import { normalizeShopifyOrder } from '../../supabase/functions/_shared/integrations/shopify';
import { normalizeWooOrder } from '../../supabase/functions/_shared/integrations/woocommerce';

describe('valores monetários', () => {
  it('converte texto decimal em centavos sem float', () => {
    expect(decimalToCents('59.90')).toBe(5990);
    expect(decimalToCents('1234')).toBe(123400);
    expect(decimalToCents('0.5')).toBe(50);
    expect(decimalToCents('0.00')).toBe(0);
    expect(decimalToCents(19.9)).toBe(1990);
    // 0,1 + 0,2 é o caso clássico de erro de ponto flutuante.
    expect(decimalToCents('0.30')).toBe(30);
    expect(decimalToCents('10.005')).toBe(1001);
    expect(decimalToCents('10.004')).toBe(1000);
  });

  it('recusa texto que não é valor', () => {
    for (const bad of ['', 'abc', '1,50', '1.2.3', null, undefined, {}]) {
      expect(() => decimalToCents(bad)).toThrow(NormalizeError);
    }
  });
});

describe('endereço', () => {
  it('separa rua e número', () => {
    expect(splitStreet('Av. Paulista, 1000')).toEqual({ street: 'Av. Paulista', number: '1000' });
    expect(splitStreet('Rua 25 de Março 100')).toEqual({
      street: 'Rua 25 de Março',
      number: '100',
    });
    expect(splitStreet('Rua das Flores - 12B')).toEqual({
      street: 'Rua das Flores',
      number: '12B',
    });
    expect(splitStreet('Rua das Flores, s/n')).toEqual({ street: 'Rua das Flores', number: 'S/N' });
    expect(splitStreet('Rua das Flores')).toEqual({ street: 'Rua das Flores', number: 'S/N' });
  });
});

describe('assinatura de webhook', () => {
  it('HMAC-SHA256 em base64 confere com o vetor de teste conhecido', async () => {
    const hex = 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8';
    const bytes = hex.match(/../g)!.map((h) => String.fromCharCode(parseInt(h, 16)));
    const expected = btoa(bytes.join(''));
    expect(await hmacBase64('key', 'The quick brown fox jumps over the lazy dog')).toBe(expected);
  });

  it('aceita a assinatura correta e rejeita corpo alterado, segredo errado e ausência', async () => {
    const body = JSON.stringify({ id: 1 });
    const sig = await hmacBase64('segredo-de-webhook-123', body);
    expect(await verifySignature('segredo-de-webhook-123', body, sig)).toBe(true);
    expect(await verifySignature('segredo-de-webhook-123', body + ' ', sig)).toBe(false);
    expect(await verifySignature('outro-segredo-123456', body, sig)).toBe(false);
    expect(await verifySignature('segredo-de-webhook-123', body, null)).toBe(false);
    expect(await verifySignature('segredo-de-webhook-123', body, '')).toBe(false);
  });

  it('comparação em tempo constante distingue tamanhos e conteúdos', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

const shopifyOrder = {
  id: 4501234567890,
  name: '#1001',
  email: 'maria@example.com',
  phone: null,
  note: 'Entregar à tarde',
  financial_status: 'paid',
  total_discounts: '5.00',
  cancelled_at: null,
  shipping_lines: [{ price: '15.00' }],
  line_items: [
    { id: 1, sku: 'CANECA-SHOP', quantity: 2, price: '35.00' },
    { id: 2, sku: '', variant_id: 777, quantity: 1, price: '15.50' },
  ],
  shipping_address: {
    name: 'Maria Cliente',
    address1: 'Av. Paulista, 1000',
    address2: 'Apto 12',
    city: 'São Paulo',
    province_code: 'sp',
    zip: '01310-100',
    phone: '(11) 98765-4321',
  },
  customer: { first_name: 'Maria', last_name: 'Cliente', email: 'maria@example.com' },
};

describe('Shopify', () => {
  it('normaliza um pedido pago', () => {
    const res = normalizeShopifyOrder(shopifyOrder);
    expect(res.kind).toBe('order');
    if (res.kind !== 'order') return;
    expect(res.externalId).toBe('4501234567890');
    expect(res.order).toEqual({
      customer_name: 'Maria Cliente',
      customer_email: 'maria@example.com',
      customer_phone: '11987654321',
      ship_postal_code: '01310100',
      ship_street: 'Av. Paulista',
      ship_number: '1000',
      ship_complement: 'Apto 12',
      ship_district: 'Não informado',
      ship_city: 'São Paulo',
      ship_state: 'SP',
      shipping_cents: 1500,
      discount_cents: 500,
      notes: 'Shopify #1001 — Entregar à tarde',
      items: [
        { external_item_id: 'CANECA-SHOP', quantity: 2, unit_price_cents: 3500 },
        { external_item_id: 'variant:777', quantity: 1, unit_price_cents: 1550 },
      ],
    });
  });

  it('ignora pedido cancelado, estornado e sem endereço de entrega', () => {
    expect(
      normalizeShopifyOrder({ ...shopifyOrder, cancelled_at: '2026-01-01T00:00:00Z' }).kind,
    ).toBe('skip');
    expect(normalizeShopifyOrder({ ...shopifyOrder, financial_status: 'refunded' }).kind).toBe(
      'skip',
    );
    expect(normalizeShopifyOrder({ ...shopifyOrder, shipping_address: null }).kind).toBe('skip');
  });

  it('descarta telefone e e-mail inválidos em vez de derrubar o pedido', () => {
    const res = normalizeShopifyOrder({
      ...shopifyOrder,
      email: 'nao-e-email',
      customer: {},
      shipping_address: { ...shopifyOrder.shipping_address, phone: '123' },
    });
    expect(res.kind === 'order' && res.order.customer_email).toBeFalsy();
    expect(res.kind === 'order' && res.order.customer_phone).toBeFalsy();
  });

  it('erra para payload sem estrutura mínima', () => {
    expect(() => normalizeShopifyOrder(null)).toThrow(NormalizeError);
    expect(() => normalizeShopifyOrder({ id: 1, line_items: [] })).toThrow(NormalizeError);
    expect(() =>
      normalizeShopifyOrder({ ...shopifyOrder, line_items: [{ quantity: 1, price: '1.00' }] }),
    ).toThrow(/SKU/);
  });
});

const wooOrder = {
  id: 727,
  number: '727',
  status: 'processing',
  shipping_total: '10.00',
  discount_total: '2.50',
  customer_note: '',
  billing: {
    first_name: 'João',
    last_name: 'Silva',
    email: 'joao@example.com',
    phone: '11912345678',
    cpf: '529.982.247-25',
  },
  shipping: {
    first_name: 'João',
    last_name: 'Silva',
    address_1: 'Rua das Flores',
    number: '250',
    address_2: 'Fundos',
    neighborhood: 'Centro',
    city: 'Campinas',
    state: 'SP',
    postcode: '13010-000',
  },
  line_items: [
    { id: 1, sku: 'COPO-WOO', quantity: 3, price: 15, subtotal: '45.00', total: '42.50' },
    { id: 2, sku: '', product_id: 99, quantity: 1, subtotal: '9.99' },
  ],
};

describe('WooCommerce', () => {
  it('normaliza usando os campos do Brazilian Market', () => {
    const res = normalizeWooOrder(wooOrder);
    expect(res.kind).toBe('order');
    if (res.kind !== 'order') return;
    expect(res.externalId).toBe('727');
    expect(res.order).toEqual({
      customer_name: 'João Silva',
      customer_email: 'joao@example.com',
      customer_phone: '11912345678',
      customer_document: '52998224725',
      ship_postal_code: '13010000',
      ship_street: 'Rua das Flores',
      ship_number: '250',
      ship_complement: 'Fundos',
      ship_district: 'Centro',
      ship_city: 'Campinas',
      ship_state: 'SP',
      shipping_cents: 1000,
      discount_cents: 250,
      notes: 'WooCommerce #727',
      items: [
        { external_item_id: 'COPO-WOO', quantity: 3, unit_price_cents: 1500 },
        { external_item_id: 'product:99', quantity: 1, unit_price_cents: 999 },
      ],
    });
  });

  it('sem campos do plugin, extrai o número da rua e usa cobrança quando não há entrega', () => {
    const res = normalizeWooOrder({
      ...wooOrder,
      shipping: {},
      billing: {
        ...wooOrder.billing,
        address_1: 'Av. Brasil, 77',
        city: 'Rio',
        state: 'rj',
        postcode: '20000000',
      },
    });
    expect(res.kind === 'order' && res.order).toMatchObject({
      ship_street: 'Av. Brasil',
      ship_number: '77',
      ship_district: 'Não informado',
      ship_state: 'RJ',
    });
  });

  it('só importa pedidos pagos/em andamento', () => {
    for (const status of ['pending', 'failed', 'cancelled', 'refunded', 'trash', '']) {
      expect(normalizeWooOrder({ ...wooOrder, status }).kind).toBe('skip');
    }
    for (const status of ['processing', 'on-hold', 'completed']) {
      expect(normalizeWooOrder({ ...wooOrder, status }).kind).toBe('order');
    }
  });

  it('erra para payload sem estrutura mínima ou quantidade inválida', () => {
    expect(() => normalizeWooOrder({})).toThrow(NormalizeError);
    expect(() =>
      normalizeWooOrder({ ...wooOrder, line_items: [{ sku: 'X', quantity: 0, subtotal: '1.00' }] }),
    ).toThrow(/quantidade/);
  });
});
