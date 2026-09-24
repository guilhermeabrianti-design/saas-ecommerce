import { catalogErrorMessage } from './catalog';
import {
  listingFormSchema,
  toListingFormValues,
  toListingPayload,
} from '../supplier/catalog-listing';

describe('catalogErrorMessage', () => {
  it('traduz erros do catálogo', () => {
    expect(catalogErrorMessage({ message: 'catalog.already_imported' })).toMatch(
      /já foi importado/,
    );
    expect(catalogErrorMessage({ message: 'catalog.sellers_only' })).toMatch(/vendedoras/);
  });

  it('sugere prefixo quando o SKU colide', () => {
    expect(catalogErrorMessage({ code: '23505', message: 'products.sku_taken' })).toMatch(
      /prefixo/,
    );
  });

  it('não exibe mensagens desconhecidas', () => {
    expect(catalogErrorMessage({ message: 'relation "x" does not exist' })).toBe(
      'Não foi possível concluir a operação. Tente novamente.',
    );
  });
});

describe('formulário de anúncio (fornecedor)', () => {
  it('exige preço de atacado; sugerido é opcional', () => {
    expect(
      listingFormSchema.safeParse({ wholesale: '', suggested: '', isPublished: true }).success,
    ).toBe(false);
    const parsed = listingFormSchema.parse({
      wholesale: '30',
      suggested: '',
      isPublished: true,
      categoryId: '',
    });
    expect(toListingPayload(parsed)).toEqual({
      wholesale_price_cents: 3000,
      suggested_price_cents: null,
      is_published: true,
      category_id: null,
    });
  });

  it('ida e volta com o anúncio salvo', () => {
    const values = toListingFormValues({
      id: '11111111-2222-4333-8444-555555555555',
      wholesale_price_cents: 3000,
      suggested_price_cents: 7990,
      is_published: false,
      category_id: '99999999-2222-4333-8444-555555555555',
    });
    expect(values).toEqual({
      wholesale: '30,00',
      suggested: '79,90',
      isPublished: false,
      categoryId: '99999999-2222-4333-8444-555555555555',
    });
    expect(toListingPayload(listingFormSchema.parse(values))).toMatchObject({
      wholesale_price_cents: 3000,
      suggested_price_cents: 7990,
      category_id: '99999999-2222-4333-8444-555555555555',
    });
    expect(toListingFormValues(null)).toEqual({
      wholesale: '',
      suggested: '',
      isPublished: false,
      categoryId: '',
    });
  });
});
