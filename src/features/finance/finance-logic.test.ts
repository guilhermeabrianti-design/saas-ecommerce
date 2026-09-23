import { financeErrorMessage } from './api';
import { paymentFormSchema, paymentStatus, periodStart } from './schemas';

const order = (paid: number, refunded: number, total = 6000) => ({
  total_cents: total,
  paid_cents: paid,
  refunded_cents: refunded,
});

describe('situação de pagamento', () => {
  it('deriva do líquido recebido (pago − estornado)', () => {
    expect(paymentStatus(order(0, 0))).toBe('unpaid');
    expect(paymentStatus(order(2500, 0))).toBe('partial');
    expect(paymentStatus(order(6000, 0))).toBe('paid');
    expect(paymentStatus(order(6000, 1000))).toBe('partial');
    expect(paymentStatus(order(6000, 6000))).toBe('refunded');
  });

  it('pedido de valor zero conta como pago', () => {
    expect(paymentStatus(order(0, 0, 0))).toBe('paid');
  });
});

describe('formulário de pagamento', () => {
  const base = { amount: '15,00', method: 'pix', note: '' };

  it('aceita valores em reais e rejeita zero, texto e frações de centavo', () => {
    expect(paymentFormSchema.safeParse(base).success).toBe(true);
    expect(paymentFormSchema.safeParse({ ...base, amount: '1.234,56' }).success).toBe(true);
    for (const amount of ['', '0', '0,00', 'abc', '10,999']) {
      expect(paymentFormSchema.safeParse({ ...base, amount }).success).toBe(false);
    }
  });

  it('rejeita forma desconhecida e observação longa', () => {
    expect(paymentFormSchema.safeParse({ ...base, method: 'cheque' }).success).toBe(false);
    expect(paymentFormSchema.safeParse({ ...base, note: 'x'.repeat(501) }).success).toBe(false);
  });
});

describe('período', () => {
  it('calcula o início a partir de agora e devolve null para todo o período', () => {
    const now = new Date('2026-09-23T12:00:00Z');
    expect(periodStart('30', now)).toBe('2026-08-24T12:00:00.000Z');
    expect(periodStart('all', now)).toBeNull();
  });
});

describe('mensagens de erro', () => {
  it('traduz erros do financeiro e cai nos erros de organização', () => {
    expect(financeErrorMessage({ message: 'finance.overpayment' })).toMatch(/ultrapassa/);
    expect(financeErrorMessage({ message: 'finance.already_paid' })).toMatch(/já foi pago/);
    expect(financeErrorMessage({ message: 'org.forbidden' })).not.toMatch(/finance/);
  });
});
