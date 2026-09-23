import { productErrorMessage } from './errors';
import { imageStoragePath, MAX_IMAGE_BYTES, moveItem, validateImageFile } from './images';
import {
  emptyVariantForm,
  toVariantFormValues,
  toVariantPayload,
  variantFormSchema,
  type VariantFormValues,
} from './variants';

const ORG = '11111111-2222-4333-8444-555555555555';
const PRODUCT = '66666666-7777-4888-9999-aaaaaaaaaaaa';

const valid: VariantFormValues = {
  sku: 'CAM-AZ-M',
  attributes: [
    { name: ' Cor ', value: 'Azul ' },
    { name: 'Tamanho', value: 'M' },
  ],
  price: '',
  gtin: '',
  weightGrams: '',
};

describe('variantFormSchema', () => {
  it('aceita variação válida e ignora linhas de atributo vazias', () => {
    const res = variantFormSchema.safeParse({
      ...valid,
      attributes: [...valid.attributes, { name: '', value: '' }],
    });
    expect(res.success).toBe(true);
  });

  it('exige ao menos um atributo', () => {
    const res = variantFormSchema.safeParse({ ...valid, attributes: [{ name: '', value: '' }] });
    expect(res.error?.issues[0]?.path).toEqual(['attributes']);
  });

  it('rejeita atributo sem valor e nome repetido', () => {
    const noValue = variantFormSchema.safeParse({
      ...valid,
      attributes: [{ name: 'Cor', value: '' }],
    });
    expect(noValue.error?.issues[0]?.path).toEqual(['attributes', 0, 'value']);

    const repeated = variantFormSchema.safeParse({
      ...valid,
      attributes: [
        { name: 'Cor', value: 'Azul' },
        { name: 'cor', value: 'Verde' },
      ],
    });
    expect(repeated.error?.issues[0]?.path).toEqual(['attributes', 1, 'name']);
  });

  it('sugere os atributos já usados no produto', () => {
    expect(emptyVariantForm(['Cor', 'Tamanho']).attributes).toEqual([
      { name: 'Cor', value: '' },
      { name: 'Tamanho', value: '' },
    ]);
  });
});

describe('toVariantPayload', () => {
  it('apara atributos e usa null para herdar do produto', () => {
    expect(toVariantPayload(variantFormSchema.parse({ ...valid, price: '59,90' }))).toEqual({
      sku: 'CAM-AZ-M',
      attributes: { Cor: 'Azul', Tamanho: 'M' },
      price_cents: 5990,
      gtin: null,
      weight_grams: null,
    });
  });

  it('ida e volta com o formulário', () => {
    const payload = toVariantPayload(variantFormSchema.parse(valid));
    const back = toVariantFormValues({ id: PRODUCT, is_active: true, ...payload });
    expect(toVariantPayload(variantFormSchema.parse(back))).toEqual(payload);
  });
});

describe('imagens', () => {
  const file = (type: string, size = 1000) => new File([new Uint8Array(size)], 'foto', { type });

  it('valida tipo e tamanho antes do envio', () => {
    expect(validateImageFile(file('image/webp'))).toBeNull();
    expect(validateImageFile(file('image/svg+xml'))).toMatch(/JPEG, PNG ou WebP/);
    expect(validateImageFile(file('image/png', MAX_IMAGE_BYTES + 1))).toMatch(/5 MB/);
  });

  it('gera caminho aceito pela constraint e pelas policies do banco', () => {
    const path = imageStoragePath(ORG, PRODUCT, file('image/jpeg'));
    // Same pattern as the product_images check constraint.
    expect(path).toMatch(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{1,64}\.(jpg|png|webp)$/);
    expect(path.startsWith(`${ORG}/${PRODUCT}/`)).toBe(true);
    expect(imageStoragePath(ORG, PRODUCT, file('image/jpeg'))).not.toBe(path);
  });

  it('moveItem troca posições e ignora movimentos para fora', () => {
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
});

describe('productErrorMessage (fase 5)', () => {
  it('distingue SKU em uso de combinação de atributos repetida', () => {
    expect(productErrorMessage({ code: '23505', message: 'products.sku_taken' })).toMatch(/SKU/);
    expect(
      productErrorMessage({
        code: '23505',
        message:
          'duplicate key value violates unique constraint "product_variants_product_id_attributes_key"',
      }),
    ).toMatch(/atributos/);
  });

  it('explica limite de imagens', () => {
    expect(productErrorMessage({ message: 'products.image_limit' })).toMatch(/10 imagens/);
  });
});
