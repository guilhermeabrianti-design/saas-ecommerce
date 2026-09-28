import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import {
  CheckoutError,
  offerSchema,
  orderStatusSchema,
  paymentStatuses,
  productCheckoutSchema,
  shouldPoll,
} from './checkout';

/** Código estável (`error`) e campo (`field`) do corpo de respostas não-2xx da função. */
async function toCheckoutError(error: unknown): Promise<CheckoutError> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = (await error.context.json()) as { error?: unknown; field?: unknown } | null;
      if (typeof body?.error === 'string') {
        return new CheckoutError(body.error, typeof body.field === 'string' ? body.field : null);
      }
    } catch {
      // corpo não-JSON: erro genérico abaixo
    }
  }
  return new CheckoutError('unknown');
}

export const checkoutKeys = {
  offer: (productId: string) => ['checkout-offer', productId] as const,
  status: (token: string) => ['checkout-status', token] as const,
  product: (productId: string) => ['checkout-product', productId] as const,
  adminSummary: ['checkout-admin', 'summary'] as const,
  adminPayments: (filter: string, page: number) =>
    ['checkout-admin', 'payments', filter, page] as const,
};

// ---------------------------------------------------------------------
// Comprador
// ---------------------------------------------------------------------

export function useCheckoutOffer(productId: string) {
  return useQuery({
    queryKey: checkoutKeys.offer(productId),
    retry: false,
    // URLs das fotos valem 1 hora.
    staleTime: 30 * 60_000,
    queryFn: async () => {
      if (!z.uuid().safeParse(productId).success) return null;
      const { data, error } = await getSupabase().functions.invoke(`checkout/offer/${productId}`, {
        method: 'GET',
      });
      if (error) {
        const e = await toCheckoutError(error);
        if (e.code === 'not_found') return null;
        throw e;
      }
      return offerSchema.parse(data);
    },
  });
}

const payResultSchema = z.object({
  token: z.uuid(),
  order_number: z.number().int(),
  status: z.enum(paymentStatuses),
  status_detail: z.string().nullable().optional(),
});

export interface PayInput {
  product_id: string;
  variant_id: string | null;
  quantity: number;
  request_id: string;
  buyer: Record<string, unknown>;
  payment: Record<string, unknown>;
  /** Link ou vitrine por onde o comprador chegou (Fase 23). */
  attribution?: { store_code: string | null; link_code: string | null } | null;
}

export function usePay() {
  return useMutation({
    mutationFn: async (input: PayInput) => {
      const { data, error } = await getSupabase().functions.invoke('checkout/pay', { body: input });
      if (error) throw await toCheckoutError(error);
      return payResultSchema.parse(data);
    },
  });
}

export function useSubmitReview(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { rating: number; comment: string }) => {
      const { error } = await getSupabase().functions.invoke('checkout/review', {
        body: { token, rating: input.rating, comment: input.comment.trim() || null },
      });
      if (error) throw await toCheckoutError(error);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: checkoutKeys.status(token) }),
  });
}

export function useCheckoutOrderStatus(token: string) {
  return useQuery({
    queryKey: checkoutKeys.status(token),
    queryFn: async () => {
      if (!z.uuid().safeParse(token).success) return null;
      const { data, error } = await getSupabase().rpc('checkout_order_status', { p_token: token });
      if (error) throw error;
      return data ? orderStatusSchema.parse(data) : null;
    },
    // PIX/boleto: acompanha a confirmação sem recarregar a página.
    refetchInterval: (query) => (shouldPoll(query.state.data) ? 5000 : false),
  });
}

// ---------------------------------------------------------------------
// Vendedor
// ---------------------------------------------------------------------

export function useProductCheckout(productId: string) {
  return useQuery({
    queryKey: checkoutKeys.product(productId),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('checkout_product_summary', {
        p_product: productId,
      });
      if (error) throw error;
      return productCheckoutSchema.parse(data);
    },
  });
}

export function useSetProductCheckout(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      const { error } = await getSupabase().rpc('set_product_checkout', {
        p_product: productId,
        p_enabled: enabled,
      });
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: checkoutKeys.product(productId) }),
  });
}

export function productCheckoutErrorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  if (message === 'checkout.not_eligible')
    return 'Este produto não pode ser vendido pelo checkout agora.';
  if (message === 'checkout.not_found') return 'Produto não encontrado ou sem permissão.';
  return 'Não foi possível atualizar o checkout. Tente de novo.';
}

// ---------------------------------------------------------------------
// Equipe
// ---------------------------------------------------------------------

export const ADMIN_PAYMENTS_PAGE_SIZE = 50;

const summarySchema = z.object({
  approved_cents: z.number().int(),
  fees_cents: z.number().int(),
  supplier_cents: z.number().int(),
  commission_cents: z.number().int(),
  platform_cents: z.number().int(),
  needs_refund: z.number().int(),
});

const adminPaymentSchema = z.object({
  order_id: z.uuid(),
  order_number: z.number().int(),
  store_name: z.string(),
  external_id: z.string(),
  method: z.enum(['pix', 'card', 'boleto']).nullable(),
  status: z.enum(paymentStatuses),
  status_detail: z.string().nullable(),
  amount_cents: z.number().int(),
  fee_cents: z.number().int().nullable(),
  supplier_cents: z.number().int().nullable(),
  commission_cents: z.number().int().nullable(),
  platform_cents: z.number().int().nullable(),
  needs_refund: z.boolean(),
  refund_reason: z.string().nullable(),
  refundable: z.boolean(),
  created_at: z.string(),
  approved_at: z.string().nullable(),
});

export type AdminPayment = z.infer<typeof adminPaymentSchema>;
export type AdminPaymentFilter = 'all' | 'needs_refund' | 'approved';

export function useCheckoutSummary() {
  return useQuery({
    queryKey: checkoutKeys.adminSummary,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_checkout_summary');
      if (error) throw error;
      return summarySchema.parse(data);
    },
  });
}

export function useCheckoutPayments(filter: AdminPaymentFilter, page: number) {
  return useQuery({
    queryKey: checkoutKeys.adminPayments(filter, page),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_checkout_payments', {
        p_filter: filter,
        p_limit: ADMIN_PAYMENTS_PAGE_SIZE,
        p_offset: (page - 1) * ADMIN_PAYMENTS_PAGE_SIZE,
      });
      if (error) throw error;
      return z.array(adminPaymentSchema).parse(data);
    },
  });
}

export function useRefundCheckout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (orderId: string) => {
      const { error } = await getSupabase().functions.invoke('checkout/refund', {
        body: { order_id: orderId },
      });
      if (error) throw await toCheckoutError(error);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['checkout-admin'] }),
  });
}
