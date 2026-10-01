// @vitest-environment node
import {
  NormalizeError,
  decimalToCents,
  hmacBase64,
  splitStreet,
  timingSafeEqual,
  verifySignature,
} from '../../supabase/functions/_shared/integrations/common';

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
