import { inventoryErrorMessage } from './errors';
import { previewOnHand, stockFormSchema, toStockRequest, type StockFormValues } from './schemas';

const form = (mode: StockFormValues['mode'], quantity: string, note = ''): StockFormValues => ({
  mode,
  quantity,
  note,
});

describe('stockFormSchema', () => {
  it.each([
    ['purchase', '10'],
    ['return', '1'],
    ['loss', '3'],
    ['adjustment', '-4'],
    ['adjustment', '+4'],
    ['count', '0'],
  ] as const)('aceita %s %s', (mode, qty) => {
    expect(stockFormSchema.safeParse(form(mode, qty)).success).toBe(true);
  });

  it.each([
    ['purchase', '0'],
    ['purchase', '-1'],
    ['loss', '-3'],
    ['adjustment', '0'],
    ['adjustment', '1.5'],
    ['purchase', '2000000'],
    ['count', '-1'],
    ['count', ''],
  ] as const)('rejeita %s %j', (mode, qty) => {
    const res = stockFormSchema.safeParse(form(mode, qty));
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]?.path).toEqual(['quantity']);
  });
});

describe('toStockRequest', () => {
  it('perda vira delta negativo; contagem vira set_stock', () => {
    expect(toStockRequest(form('loss', '3', 'quebrou'))).toEqual({
      kind: 'adjust',
      delta: -3,
      reason: 'loss',
      note: 'quebrou',
    });
    expect(toStockRequest(form('adjustment', '-2'))).toMatchObject({
      delta: -2,
      reason: 'adjustment',
    });
    expect(toStockRequest(form('count', '7'))).toEqual({ kind: 'set', quantity: 7, note: '' });
  });
});

describe('previewOnHand', () => {
  it('mostra o saldo resultante só para valores válidos', () => {
    expect(previewOnHand(10, form('purchase', '5'))).toBe(15);
    expect(previewOnHand(10, form('loss', '4'))).toBe(6);
    expect(previewOnHand(10, form('count', '3'))).toBe(3);
    expect(previewOnHand(10, form('purchase', ''))).toBeNull();
  });
});

describe('inventoryErrorMessage', () => {
  it('traduz erros do estoque e herda os de produto', () => {
    expect(inventoryErrorMessage({ message: 'inventory.insufficient_stock' })).toMatch(
      /insuficiente/,
    );
    expect(inventoryErrorMessage({ message: 'inventory.ledger_immutable' })).toMatch(/Arquive/);
    expect(inventoryErrorMessage({ message: 'org.forbidden' })).toMatch(/permissão/);
  });
});
