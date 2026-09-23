import { integrationErrorMessage, retryMessages } from './api';
import {
  connectionFormSchema,
  generateSecret,
  linkFormSchema,
  providerLabels,
  providers,
  webhookUrl,
} from './schemas';

const ITEM = '11111111-2222-4333-8444-555555555555';

describe('formulário de conexão', () => {
  const valid = {
    provider: 'shopify',
    name: 'Loja principal',
    externalAccountId: 'minha-loja.myshopify.com',
    secret: 'segredo-de-webhook-1234',
  };

  it('aceita dados válidos e exige segredo de 16+ caracteres', () => {
    expect(connectionFormSchema.safeParse(valid).success).toBe(true);
    expect(connectionFormSchema.safeParse({ ...valid, secret: 'curto' }).success).toBe(false);
    expect(connectionFormSchema.safeParse({ ...valid, name: 'a' }).success).toBe(false);
  });

  it('só permite provedores já conectáveis', () => {
    expect(connectionFormSchema.safeParse({ ...valid, provider: 'woocommerce' }).success).toBe(
      true,
    );
    expect(connectionFormSchema.safeParse({ ...valid, provider: 'shopee' }).success).toBe(false);
  });
});

describe('formulário de vínculo', () => {
  it('exige item de estoque válido e SKU', () => {
    const ok = { inventoryItemId: ITEM, externalId: ' CANECA-SHOP ', syncStock: true };
    expect(linkFormSchema.safeParse(ok).success).toBe(true);
    expect(linkFormSchema.safeParse({ ...ok, inventoryItemId: '' }).success).toBe(false);
    expect(linkFormSchema.safeParse({ ...ok, externalId: '  ' }).success).toBe(false);
  });
});

describe('URL do webhook', () => {
  it('monta a URL da Edge Function sem barras duplicadas', () => {
    expect(webhookUrl('https://abc.supabase.co/', 'shopify', ITEM)).toBe(
      `https://abc.supabase.co/functions/v1/webhooks/shopify/${ITEM}`,
    );
  });

  it('sem Supabase configurado, deixa um marcador explícito', () => {
    expect(webhookUrl(undefined, 'woocommerce', ITEM)).toContain('<URL-do-projeto-Supabase>');
  });
});

describe('segredo gerado', () => {
  it('tem 48 hex e não se repete', () => {
    const a = generateSecret();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(generateSecret()).not.toBe(a);
  });
});

describe('mensagens', () => {
  it('traduz erros de integração e cai nos erros de organização', () => {
    expect(integrationErrorMessage({ message: 'integrations.invalid_item' })).toMatch(
      /estoque próprio/,
    );
    expect(integrationErrorMessage({ code: '23505', message: 'x' })).toMatch(/Já existe/);
    expect(integrationErrorMessage({ message: 'org.forbidden' })).not.toMatch(/integrations/);
  });

  it('há mensagem para todo resultado de reprocessamento e nome para todo provedor', () => {
    expect(Object.keys(retryMessages).sort()).toEqual(
      ['created', 'duplicate', 'inactive', 'invalid', 'unmapped'].sort(),
    );
    for (const p of providers) expect(providerLabels[p]).toBeTruthy();
  });
});
