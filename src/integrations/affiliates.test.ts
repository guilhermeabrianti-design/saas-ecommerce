// @vitest-environment node
import {
  parseAttribution,
  parsePublicCode,
  parseVisit,
  visitorHash,
} from '../../supabase/functions/_shared/affiliates';
import { parseCheckoutRequest } from '../../supabase/functions/_shared/payments/mercadopago';

const visitor = '3f2b8c1e-5a4d-4e6f-9b7a-0c1d2e3f4a5b';

describe('códigos públicos', () => {
  it('normaliza e valida', () => {
    expect(parsePublicCode(' Loja-Da-Ana ')).toBe('loja-da-ana');
    expect(parsePublicCode('abcd')).toBe('abcd');
    for (const bad of ['abc', '-abcd', 'abcd-', 'a--bcd', 'ação', 'a b c d', 'x'.repeat(33), 42]) {
      expect(parsePublicCode(bad)).toBeNull();
    }
  });

  it('origem inválida é descartada sem erro', () => {
    expect(parseAttribution({ store_code: 'LOJA-V', link_code: 'bio' })).toEqual({
      store_code: 'loja-v',
      link_code: null,
    });
    expect(parseAttribution({ link_code: '<script>' })).toBeNull();
    expect(parseAttribution('loja')).toBeNull();
    expect(parseAttribution(null)).toBeNull();
  });
});

describe('visitante', () => {
  it('guarda só o hash, estável e sem diferença de caixa', async () => {
    const h = await visitorHash(visitor);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(visitor.replace(/-/g, ''));
    expect(await visitorHash(visitor.toUpperCase())).toBe(h);
    expect(await visitorHash('nao-e-uuid')).toBeNull();
  });

  it('visita exige código e visitante válidos', async () => {
    expect(await parseVisit({ link_code: 'Stories', visitor_id: visitor })).toMatchObject({
      link_code: 'stories',
      store_code: null,
      visitor: await visitorHash(visitor),
    });
    expect(await parseVisit({ store_code: 'loja-v' })).toBeNull();
    expect(await parseVisit({ visitor_id: visitor })).toBeNull();
    expect(await parseVisit(null)).toBeNull();
  });
});

describe('pagamento com origem', () => {
  const base = {
    product_id: '5b7c2a53-6d4e-4c1b-9f53-0b3f6f0f7a11',
    variant_id: null,
    request_id: '9e1f5d86-9a7b-4f4e-8c86-3e6c9c3cad44',
    quantity: 1,
    payment: { payment_method_id: 'pix' },
    buyer: {
      customer_name: 'Maria da Silva',
      customer_email: 'maria@example.com',
      customer_phone: '11987654321',
      customer_document: '12345678909',
      ship_postal_code: '01310100',
      ship_street: 'Av. Paulista',
      ship_number: '1000',
      ship_complement: '',
      ship_district: 'Bela Vista',
      ship_city: 'São Paulo',
      ship_state: 'SP',
    },
  };

  it('leva a origem válida e ignora a inválida', () => {
    expect(
      parseCheckoutRequest({ ...base, attribution: { link_code: 'Bio-Insta' } }).attribution,
    ).toEqual({ store_code: null, link_code: 'bio-insta' });
    expect(
      parseCheckoutRequest({ ...base, attribution: { link_code: '!!' } }).attribution,
    ).toBeNull();
    expect(parseCheckoutRequest(base).attribution).toBeNull();
  });
});
