import type { FeeOptions } from '@/features/fees/fees';
import {
  channelErrorMessage,
  channelForm,
  defaultListingType,
  fitTitle,
  freeShippingWarning,
  validateChannel,
  type ChannelConfig,
} from './channels';

const options: FeeOptions[] = [
  {
    provider: 'mercadolivre',
    types: [
      { value: 'classico', label: 'Clássico', campaigns: [] },
      { value: 'premium', label: 'Premium', campaigns: [] },
    ],
  },
  { provider: 'tiktok', types: [{ value: 'padrao', label: 'Padrão', campaigns: [] }] },
];

const product = {
  name: 'Camiseta Masculina Algodão Premium Azul Marinho Gola Redonda Manga Curta Tamanho G',
  price_cents: 8990,
};

describe('sugestão por canal', () => {
  it('título cabe no limite sem cortar palavra; Clássico por padrão no Mercado Livre', () => {
    const ml = channelForm('mercadolivre', undefined, product, options);
    expect(ml.title.length).toBeLessThanOrEqual(60);
    expect(product.name.startsWith(ml.title)).toBe(true);
    expect(ml.title.endsWith(' ')).toBe(false);
    expect(ml).toMatchObject({
      enabled: true,
      price: '89,90',
      listingType: 'classico',
      freeShipping: true,
    });
    expect(channelForm('tiktok', undefined, product, options)).toMatchObject({
      title: product.name,
      listingType: 'padrao',
      freeShipping: false,
    });
    // Sem taxa cadastrada: nenhum tipo.
    expect(defaultListingType('shopee', options)).toBe('');
    expect(fitTitle('  curto  ', 60)).toBe('curto');
  });

  it('o que está salvo vence a sugestão', () => {
    const saved: ChannelConfig = {
      id: '11111111-2222-4333-8444-555555555555',
      product_id: '11111111-2222-4333-8444-555555555556',
      provider: 'mercadolivre',
      enabled: false,
      title: 'Meu título',
      price_cents: 9990,
      listing_type: 'premium',
      category_id: null,
      marketplace_category: 'MLB1234',
      free_shipping: false,
      updated_at: '2026-10-01T12:00:00Z',
      attributes: [],
      variation_map: {},
      external_id: null,
      external_url: null,
      publish_status: null,
      last_error: null,
      published_at: null,
    };
    expect(channelForm('mercadolivre', saved, product, options)).toEqual({
      enabled: false,
      title: 'Meu título',
      price: '99,90',
      listingType: 'premium',
      categoryId: '',
      marketplaceCategory: 'MLB1234',
      freeShipping: false,
    });
  });
});

describe('validação', () => {
  const base = channelForm(
    'mercadolivre',
    undefined,
    { name: 'Caneca', price_cents: 3500 },
    options,
  );

  it('título, preço, tipo e código da categoria', () => {
    expect(validateChannel('mercadolivre', base)).toEqual({});
    expect(validateChannel('mercadolivre', { ...base, title: 'x'.repeat(61) }).title).toMatch(/60/);
    expect(validateChannel('tiktok', { ...base, title: 'x'.repeat(61) }).title).toBeUndefined();
    expect(validateChannel('mercadolivre', { ...base, price: 'abc' }).price).toBeTruthy();
    expect(validateChannel('shopee', { ...base, listingType: '' }).listingType).toBeTruthy();
    expect(
      validateChannel('mercadolivre', { ...base, marketplaceCategory: 'MLB 1' })
        .marketplaceCategory,
    ).toBeTruthy();
  });

  it('frete grátis obrigatório no Mercado Livre a partir de R$ 79', () => {
    expect(freeShippingWarning('mercadolivre', { ...base, price: '79,00' })).toMatch(/R\$ 79/);
    expect(
      freeShippingWarning('mercadolivre', { ...base, price: '79,00', freeShipping: true }),
    ).toBeNull();
    expect(freeShippingWarning('mercadolivre', { ...base, price: '78,99' })).toBeNull();
    expect(freeShippingWarning('tiktok', { ...base, price: '200,00' })).toBeNull();
  });

  it('erros legíveis', () => {
    expect(channelErrorMessage({ message: 'channels.listing_type_unavailable' })).toMatch(/taxa/);
    expect(channelErrorMessage({ message: 'qualquer' })).toMatch(/Tente de novo/);
  });
});
