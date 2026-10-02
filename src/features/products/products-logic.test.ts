import { sanitizeSearch, summarizeStock } from './api';
import { productErrorMessage } from './errors';
import {
  emptyProductForm,
  isValidGtin,
  productFormSchema,
  toProductFormValues,
  toProductPayload,
  type ProductFormValues,
} from './schemas';

const valid: ProductFormValues = {
  ...emptyProductForm,
  name: ' Camiseta Básica ',
  sku: 'CAM-001',
  price: '49,90',
  cost: '20',
  gtin: '7891000315507',
  weightGrams: '250',
};

describe('isValidGtin', () => {
  it.each(['7891000315507', '96385074', '036000291452', '10012345678902'])('aceita %s', (c) => {
    expect(isValidGtin(c)).toBe(true);
  });

  it.each(['7891000315508', '1234567', '12345678901', 'abcdefgh'])('rejeita %s', (c) => {
    expect(isValidGtin(c)).toBe(false);
  });
});

describe('productFormSchema', () => {
  it('aceita um produto válido', () => {
    expect(productFormSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ['sku', 'com espaço'],
    ['sku', '-comeca-com-hifen'],
    ['price', ''],
    ['price', 'dez reais'],
    ['cost', '1,999'],
    ['gtin', '7891000315508'],
    ['weightGrams', '0'],
    ['lengthMm', '2,5'],
  ] as const)('rejeita %s = %j', (field, value) => {
    const res = productFormSchema.safeParse({ ...valid, [field]: value });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]?.path).toEqual([field]);
  });
});

describe('toProductPayload', () => {
  it('converte para centavos/inteiros e vazios para null', () => {
    const payload = toProductPayload(productFormSchema.parse(valid));
    expect(payload).toEqual({
      sku: 'CAM-001',
      name: 'Camiseta Básica',
      description: '',
      brand: null,
      gtin: '7891000315507',
      price_cents: 4990,
      cost_cents: 2000,
      weight_grams: 250,
      length_mm: null,
      width_mm: null,
      height_mm: null,
      status: 'draft',
    });
  });

  it('ida e volta com o formulário', () => {
    const payload = toProductPayload(productFormSchema.parse(valid));
    expect(toProductPayload(toProductFormValues(payload))).toEqual(payload);
  });
});

describe('sanitizeSearch', () => {
  it('remove sintaxe de filtro do PostgREST e curingas', () => {
    expect(sanitizeSearch('a,sku.eq.x)or(id.neq.0')).toBe('a sku.eq.x or id.neq.0');
    expect(sanitizeSearch('100% "algodão"_*')).toBe('100 algodão');
  });

  it('limita o tamanho', () => {
    expect(sanitizeSearch('x'.repeat(500))).toHaveLength(100);
  });
});

describe('productErrorMessage', () => {
  it('explica SKU duplicado', () => {
    expect(productErrorMessage({ code: '23505', message: 'duplicate key' })).toMatch(/SKU/);
  });

  it('cai nas mensagens de organização para permissão', () => {
    expect(productErrorMessage({ code: '42501', message: 'new row violates…' })).toMatch(
      /permissão/,
    );
  });
});

describe('estoque na lista de produtos', () => {
  it('soma as variações ativas, marca estoque baixo e importado', () => {
    const p1 = '5b7c2a53-6d4e-4c1b-9f53-0b3f6f0f7a11';
    const p2 = '5b7c2a53-6d4e-4c1b-9f53-0b3f6f0f7a12';
    const stock = summarizeStock([
      { product_id: p1, available: 3, is_low: false, is_active: true, is_dropship: false },
      { product_id: p1, available: 2, is_low: true, is_active: true, is_dropship: false },
      // Variação inativa não conta.
      { product_id: p1, available: 9, is_low: true, is_active: false, is_dropship: false },
      { product_id: p2, available: -1, is_low: false, is_active: true, is_dropship: true },
    ]);
    expect(stock.get(p1)).toEqual({ available: 5, low: true, dropship: false });
    expect(stock.get(p2)).toEqual({ available: 0, low: false, dropship: true });
  });
});
