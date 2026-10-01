import { integrationErrorMessage, retryMessages } from './api';
import { linkFormSchema, providerLabels, providers } from './schemas';

const ITEM = '11111111-2222-4333-8444-555555555555';

describe('formulário de vínculo', () => {
  it('exige item de estoque válido e SKU', () => {
    const ok = { inventoryItemId: ITEM, externalId: ' CANECA-SHOP ', syncStock: true };
    expect(linkFormSchema.safeParse(ok).success).toBe(true);
    expect(linkFormSchema.safeParse({ ...ok, inventoryItemId: '' }).success).toBe(false);
    expect(linkFormSchema.safeParse({ ...ok, externalId: '  ' }).success).toBe(false);
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
