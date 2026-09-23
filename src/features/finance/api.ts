import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { orderKeys } from '@/features/orders/api';
import { orgErrorMessage } from '@/features/organizations/errors';
import { getSupabase } from '@/lib/supabase';
import { parseBRL } from '@/utils/money';
import {
  ledgerKinds,
  paymentMethods,
  periodStart,
  type PaymentFormValues,
  type PeriodValue,
} from './schemas';

export const LEDGER_PAGE_SIZE = 25;

// bigint columns arrive as numbers through PostgREST; cents stay far below 2^53.
const summarySchema = z.object({
  received_cents: z.number().int(),
  refunded_cents: z.number().int(),
  supplier_paid_cents: z.number().int(),
  supplier_received_cents: z.number().int(),
  net_cents: z.number().int(),
  payable_cents: z.number().int(),
  receivable_cents: z.number().int(),
});

const ledgerEntrySchema = z.object({
  id: z.uuid(),
  kind: z.enum(ledgerKinds),
  amount_cents: z.number().int(),
  description: z.string().nullable(),
  order_id: z.uuid().nullable(),
  created_at: z.string(),
});

const orderPaymentSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['payment', 'refund']),
  method: z.enum(paymentMethods),
  amount_cents: z.number().int(),
  note: z.string().nullable(),
  created_at: z.string(),
});

export type FinanceSummary = z.infer<typeof summarySchema>;
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
export type OrderPayment = z.infer<typeof orderPaymentSchema>;

export const financeKeys = {
  all: (orgId: string) => ['finance', orgId] as const,
  summary: (orgId: string, period: PeriodValue) => ['finance', orgId, 'summary', period] as const,
  ledger: (orgId: string, page: number) => ['finance', orgId, 'ledger', page] as const,
  payments: (orgId: string, orderId: string) => ['finance', orgId, 'payments', orderId] as const,
};

export function useFinanceSummary(orgId: string, period: PeriodValue) {
  return useQuery({
    queryKey: financeKeys.summary(orgId, period),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .rpc('finance_summary', { p_org: orgId, p_from: periodStart(period), p_to: null })
        .single();
      if (error) throw error;
      return summarySchema.parse(data);
    },
  });
}

export function useLedger(orgId: string, page: number) {
  return useQuery({
    queryKey: financeKeys.ledger(orgId, page),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const from = (page - 1) * LEDGER_PAGE_SIZE;
      const { data, error, count } = await getSupabase()
        .from('ledger_entries')
        .select('id, kind, amount_cents, description, order_id, created_at', { count: 'exact' })
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
        .range(from, from + LEDGER_PAGE_SIZE - 1);
      if (error) throw error;
      return { items: z.array(ledgerEntrySchema).parse(data), total: count ?? 0 };
    },
  });
}

export function useOrderPayments(orgId: string, orderId: string) {
  return useQuery({
    queryKey: financeKeys.payments(orgId, orderId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('order_payments')
        .select('id, kind, method, amount_cents, note, created_at')
        .eq('organization_id', orgId)
        .eq('order_id', orderId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return z.array(orderPaymentSchema).parse(data);
    },
  });
}

/** Recebimento ou estorno do pedido; `requestId` torna a repetição inofensiva. */
export function useOrderPaymentMutation(orgId: string, orderId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      kind,
      values,
      requestId,
    }: {
      kind: 'payment' | 'refund';
      values: PaymentFormValues;
      requestId: string;
    }) => {
      const cents = parseBRL(values.amount);
      if (cents === null || cents < 1) throw new Error('finance.invalid');
      const { data, error } = await getSupabase().rpc(
        kind === 'payment' ? 'record_order_payment' : 'refund_order_payment',
        {
          p_order: orderId,
          p_amount_cents: cents,
          p_method: values.method,
          p_note: values.note.trim() || null,
          p_request_id: requestId,
        },
      );
      if (error) throw error;
      return z.uuid().parse(data);
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: orderKeys.all(orgId) }),
        queryClient.invalidateQueries({ queryKey: financeKeys.all(orgId) }),
      ]),
  });
}

export function usePaySupplierOrder(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (supplierOrderId: string) => {
      const { error } = await getSupabase().rpc('pay_supplier_order', {
        p_supplier_order: supplierOrderId,
      });
      if (error) throw error;
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: orderKeys.all(orgId) }),
        queryClient.invalidateQueries({ queryKey: financeKeys.all(orgId) }),
      ]),
  });
}

const messages: Partial<Record<string, string>> = {
  'finance.not_found': 'Fornecimento não encontrado ou sem permissão para pagar.',
  'finance.invalid': 'Valor inválido. Informe um valor maior que zero.',
  'finance.overpayment': 'O valor ultrapassa o que falta receber deste pedido.',
  'finance.refund_exceeds': 'O estorno é maior que o valor já recebido (líquido de estornos).',
  'finance.order_cancelled':
    'Pedido cancelado não recebe pagamentos. Use o estorno, se for o caso.',
  'finance.not_payable': 'O fornecedor ainda não enviou (ou o fornecimento foi cancelado).',
  'finance.already_paid': 'Este fornecimento já foi pago.',
  'orders.not_found': 'Pedido não encontrado ou sem permissão para esta ação.',
};

export function financeErrorMessage(error: unknown): string {
  const { message } = (error ?? {}) as { message?: unknown };
  if (typeof message === 'string' && messages[message]) return messages[message];
  return orgErrorMessage(error);
}
