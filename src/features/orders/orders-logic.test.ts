import { isValidCnpj, isValidCpf, formatCep } from '@/utils/br';
import { orderErrorMessage } from './api';
import {
  emptyOrderForm,
  orderFormSchema,
  orderTotals,
  toOrderPayload,
  type OrderFormValues,
} from './schemas';

const ITEM = '11111111-2222-4333-8444-555555555555';

const valid: OrderFormValues = {
  ...emptyOrderForm,
  customerName: ' Maria Cliente ',
  customerEmail: 'maria@example.com',
  customerPhone: '(11) 98765-4321',
  customerDocument: '529.982.247-25',
  postalCode: '01310-100',
  street: 'Av. Paulista',
  number: '1000',
  district: 'Bela Vista',
  city: 'São Paulo',
  state: 'SP',
  shipping: '15,00',
  discount: '5',
  items: [
    {
      inventoryItemId: ITEM,
      label: 'Caneca',
      defaultPriceCents: 3000,
      available: 10,
      isDropship: false,
      quantity: '2',
      unitPrice: '',
    },
  ],
};

describe('CPF/CNPJ', () => {
  it('valida dígitos verificadores', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('529.982.247-26')).toBe(false);
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11.222.333/0001-82')).toBe(false);
    expect(formatCep('01310100')).toBe('01310-100');
  });
});

describe('orderFormSchema', () => {
  it('aceita pedido válido', () => {
    expect(orderFormSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ['customerDocument', '123.456.789-00'],
    ['postalCode', '0131010'],
    ['customerPhone', '9876'],
    ['customerEmail', 'maria@'],
    ['state', 'XX'],
  ] as const)('rejeita %s = %j', (field, value) => {
    const res = orderFormSchema.safeParse({ ...valid, [field]: value });
    expect(res.error?.issues[0]?.path).toEqual([field]);
  });

  it('exige itens e quantidade válida', () => {
    expect(orderFormSchema.safeParse({ ...valid, items: [] }).error?.issues[0]?.path).toEqual([
      'items',
    ]);
    const res = orderFormSchema.safeParse({
      ...valid,
      items: [{ ...valid.items[0]!, quantity: '0' }],
    });
    expect(res.error?.issues[0]?.path).toEqual(['items', 0, 'quantity']);
  });

  it('rejeita desconto maior que o total', () => {
    const res = orderFormSchema.safeParse({ ...valid, discount: '1000' });
    expect(res.error?.issues[0]?.path).toEqual(['discount']);
  });
});

describe('orderTotals / toOrderPayload', () => {
  it('calcula como o banco (preço padrão quando vazio)', () => {
    expect(orderTotals(valid)).toEqual({
      subtotal: 6000,
      shipping: 1500,
      discount: 500,
      total: 7000,
    });
  });

  it('gera o JSON do create_order só com dígitos e nulos', () => {
    const payload = toOrderPayload(orderFormSchema.parse({ ...valid, complement: ' ' }));
    expect(payload).toMatchObject({
      customer_name: 'Maria Cliente',
      customer_phone: '11987654321',
      customer_document: '52998224725',
      ship_postal_code: '01310100',
      ship_complement: null,
      shipping_cents: 1500,
      discount_cents: 500,
      notes: null,
      items: [{ inventory_item_id: ITEM, quantity: 2 }],
    });
    expect(payload.items[0]).not.toHaveProperty('unit_price_cents');
  });

  it('envia preço unitário quando informado', () => {
    const payload = toOrderPayload(
      orderFormSchema.parse({ ...valid, items: [{ ...valid.items[0]!, unitPrice: '25,50' }] }),
    );
    expect(payload.items[0]).toEqual({
      inventory_item_id: ITEM,
      quantity: 2,
      unit_price_cents: 2550,
    });
  });
});

describe('orderErrorMessage', () => {
  it('traduz erros de pedido', () => {
    expect(orderErrorMessage({ message: 'orders.awaiting_supplier' })).toMatch(/fornecedor/);
    expect(orderErrorMessage({ message: 'orders.insufficient_stock' })).toMatch(/insuficiente/);
    expect(orderErrorMessage({ message: 'org.forbidden' })).toMatch(/permissão/);
    expect(orderErrorMessage({ code: '23514', message: 'violates check' })).toMatch(/endereço/);
  });
});
