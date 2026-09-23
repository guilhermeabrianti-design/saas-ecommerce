import { credentialsErrorMessage, CredentialsError } from './api';
import { shopifyCredentialsSchema, wooCredentialsSchema } from './schemas';

describe('formulários de credenciais', () => {
  it('Shopify: token longo e local numérico (aceita gid)', () => {
    const ok = { accessToken: 'shpat_1234567890', locationId: '998877' };
    expect(shopifyCredentialsSchema.safeParse(ok).success).toBe(true);
    expect(
      shopifyCredentialsSchema.safeParse({ ...ok, locationId: 'gid://shopify/Location/998877' })
        .success,
    ).toBe(true);
    expect(shopifyCredentialsSchema.safeParse({ ...ok, locationId: 'abc' }).success).toBe(false);
    expect(shopifyCredentialsSchema.safeParse({ ...ok, accessToken: 'curto' }).success).toBe(false);
  });

  it('WooCommerce: key e secret com ao menos 10 caracteres', () => {
    const ok = { consumerKey: 'ck_1234567890', consumerSecret: 'cs_1234567890' };
    expect(wooCredentialsSchema.safeParse(ok).success).toBe(true);
    expect(wooCredentialsSchema.safeParse({ ...ok, consumerSecret: '' }).success).toBe(false);
  });
});

describe('mensagens de credenciais', () => {
  it('traduz os códigos da função e cai no genérico sem vazar detalhes', () => {
    expect(credentialsErrorMessage(new CredentialsError('invalid_location'))).toMatch(/local/);
    expect(credentialsErrorMessage(new CredentialsError('not_configured'))).toMatch(/criptografia/);
    expect(credentialsErrorMessage(new CredentialsError('algo_novo'))).toMatch(/Tente novamente/);
    expect(credentialsErrorMessage(new Error('boom'))).toMatch(/Tente novamente/);
  });
});
