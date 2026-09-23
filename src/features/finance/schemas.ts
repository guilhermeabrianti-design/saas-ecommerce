import { z } from 'zod';
import { parseBRL } from '@/utils/money';

export const paymentMethods = ['pix', 'card', 'boleto', 'cash', 'transfer', 'other'] as const;
export type PaymentMethod = (typeof paymentMethods)[number];

export const paymentMethodLabels: Record<PaymentMethod, string> = {
  pix: 'Pix',
  card: 'Cartão',
  boleto: 'Boleto',
  cash: 'Dinheiro',
  transfer: 'Transferência',
  other: 'Outro',
};

export const ledgerKinds = [
  'sale_payment',
  'refund',
  'supplier_payment',
  'supplier_receipt',
] as const;
export type LedgerKind = (typeof ledgerKinds)[number];

export const ledgerKindLabels: Record<LedgerKind, string> = {
  sale_payment: 'Recebimento de venda',
  refund: 'Estorno',
  supplier_payment: 'Pagamento a fornecedor',
  supplier_receipt: 'Recebimento de fornecimento',
};

export const periods = [
  { value: '30', label: 'Últimos 30 dias', days: 30 },
  { value: '90', label: 'Últimos 90 dias', days: 90 },
  { value: 'all', label: 'Todo o período', days: null },
] as const;
export type PeriodValue = (typeof periods)[number]['value'];

export type PaymentStatus = 'unpaid' | 'partial' | 'paid' | 'refunded';

export const paymentStatusLabels: Record<PaymentStatus, string> = {
  unpaid: 'Não pago',
  partial: 'Pago parcialmente',
  paid: 'Pago',
  refunded: 'Estornado',
};

/** Situação de pagamento a partir dos saldos do pedido (mesma regra do banco: líquido = pago − estornado). */
export function paymentStatus(o: {
  total_cents: number;
  paid_cents: number;
  refunded_cents: number;
}): PaymentStatus {
  const net = o.paid_cents - o.refunded_cents;
  if (o.paid_cents > 0 && net === 0) return 'refunded';
  if (o.total_cents === 0 || net >= o.total_cents) return 'paid';
  return net > 0 ? 'partial' : 'unpaid';
}

/** Início do período em ISO, ou null para "todo o período". */
export function periodStart(value: PeriodValue, now: Date = new Date()): string | null {
  const days = periods.find((p) => p.value === value)?.days;
  if (!days) return null;
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export const paymentFormSchema = z.object({
  amount: z
    .string()
    .refine((v) => (parseBRL(v) ?? 0) >= 1, { error: 'Valor inválido, ex.: 15,00' }),
  method: z.enum(paymentMethods),
  note: z.string().trim().max(500, 'Máximo de 500 caracteres'),
});
export type PaymentFormValues = z.infer<typeof paymentFormSchema>;

export const emptyPaymentForm: PaymentFormValues = { amount: '', method: 'pix', note: '' };
