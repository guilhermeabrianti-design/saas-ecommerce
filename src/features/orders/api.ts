import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { inventoryKeys } from '@/features/inventory/api';
import { orgErrorMessage } from '@/features/organizations/errors';
import { productErrorMessage } from '@/features/products/errors';
import { sanitizeSearch } from '@/features/products/api';
import { paymentStatuses } from '@/features/checkout/checkout';
import { getSupabase } from '@/lib/supabase';
import {
  orderChannels,
  orderStatuses,
  supplierOrderStatuses,
  type OrderStatus,
  type toOrderPayload,
} from './schemas';

export const ORDERS_PAGE_SIZE = 25;

const orderListSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  status: z.enum(orderStatuses),
  customer_name: z.string(),
  ship_city: z.string(),
  ship_state: z.string(),
  total_cents: z.number().int(),
  created_at: z.string(),
  channel: z.enum(orderChannels),
});

const orderItemSchema = z.object({
  id: z.uuid(),
  sku: z.string(),
  name: z.string(),
  attributes: z.record(z.string(), z.string()).nullable(),
  quantity: z.number().int(),
  unit_price_cents: z.number().int(),
  fulfillment: z.enum(['own_stock', 'supplier']),
});

const supplierOrderSummarySchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  status: z.enum(supplierOrderStatuses),
  total_wholesale_cents: z.number().int(),
  carrier: z.string().nullable(),
  tracking_code: z.string().nullable(),
  shipped_at: z.string().nullable(),
  paid_at: z.string().nullable(),
});

const orderDetailSchema = orderListSchema.extend({
  paid_cents: z.number().int(),
  refunded_cents: z.number().int(),
  customer_email: z.string().nullable(),
  customer_phone: z.string().nullable(),
  customer_document: z.string().nullable(),
  ship_postal_code: z.string(),
  ship_street: z.string(),
  ship_number: z.string(),
  ship_complement: z.string().nullable(),
  ship_district: z.string(),
  subtotal_cents: z.number().int(),
  shipping_cents: z.number().int(),
  discount_cents: z.number().int(),
  notes: z.string().nullable(),
  confirmed_at: z.string().nullable(),
  shipped_at: z.string().nullable(),
  delivered_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  order_items: z.array(orderItemSchema),
  supplier_orders: z.array(supplierOrderSummarySchema),
  // Só owner/admin leem (RLS): para os demais vem nulo.
  checkout_payments: z
    .object({
      method: z.enum(['pix', 'card', 'boleto']).nullable(),
      status: z.enum(paymentStatuses),
      amount_cents: z.number().int(),
      expires_at: z.string().nullable(),
      needs_refund: z.boolean(),
      approved_at: z.string().nullable(),
    })
    .nullable(),
  order_splits: z
    .object({
      seller_commission_bps: z.number().int(),
      seller_commission_source: z.string(),
      seller_commission_cents: z.number().int(),
      settled_at: z.string().nullable(),
    })
    .nullable(),
});

export type OrderListItem = z.infer<typeof orderListSchema>;
export type OrderDetail = z.infer<typeof orderDetailSchema>;

export interface OrderFilters {
  search: string;
  status: OrderStatus | 'all';
  page: number;
}

export const orderKeys = {
  all: (orgId: string) => ['orders', orgId] as const,
  list: (orgId: string, f: OrderFilters) => ['orders', orgId, 'list', f] as const,
  detail: (orgId: string, id: string) => ['orders', orgId, 'detail', id] as const,
};

export function useOrders(orgId: string, filters: OrderFilters) {
  return useQuery({
    queryKey: orderKeys.list(orgId, filters),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const from = (filters.page - 1) * ORDERS_PAGE_SIZE;
      let query = getSupabase()
        .from('orders')
        .select(
          'id, number, status, customer_name, ship_city, ship_state, total_cents, created_at, channel',
          {
            count: 'exact',
          },
        )
        .eq('organization_id', orgId)
        .order('number', { ascending: false })
        .range(from, from + ORDERS_PAGE_SIZE - 1);
      if (filters.status !== 'all') query = query.eq('status', filters.status);
      const term = sanitizeSearch(filters.search.replace(/^#/, ''));
      if (/^\d{1,15}$/.test(term)) query = query.eq('number', Number(term));
      else if (term) query = query.ilike('customer_name', `%${term}%`);

      const { data, error, count } = await query;
      if (error) throw error;
      return { items: z.array(orderListSchema).parse(data), total: count ?? 0 };
    },
  });
}

export function useOrder(orgId: string, id: string) {
  return useQuery({
    queryKey: orderKeys.detail(orgId, id),
    queryFn: async () => {
      if (!z.uuid().safeParse(id).success) return null;
      const { data, error } = await getSupabase()
        .from('orders')
        .select(
          `id, number, status, customer_name, customer_email, customer_phone, customer_document,
           ship_postal_code, ship_street, ship_number, ship_complement, ship_district, ship_city, ship_state,
           subtotal_cents, shipping_cents, discount_cents, total_cents, paid_cents, refunded_cents,
           notes, created_at, confirmed_at, shipped_at, delivered_at, cancelled_at, channel,
           order_items (id, sku, name, attributes, quantity, unit_price_cents, fulfillment),
           supplier_orders (id, number, status, total_wholesale_cents, carrier, tracking_code, shipped_at, paid_at),
           checkout_payments (method, status, amount_cents, expires_at, needs_refund, approved_at),
           order_splits (seller_commission_bps, seller_commission_source, seller_commission_cents, settled_at)`,
        )
        .eq('organization_id', orgId)
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return data ? orderDetailSchema.parse(data) : null;
    },
  });
}

export function useCreateOrder(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      payload,
      requestId,
    }: {
      payload: ReturnType<typeof toOrderPayload>;
      requestId: string;
    }) => {
      const { data, error } = await getSupabase().rpc('create_order', {
        p_org: orgId,
        p_order: payload,
        p_request_id: requestId,
      });
      if (error) throw error;
      return z.uuid().parse(data);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orderKeys.all(orgId) }),
  });
}

export type OrderAction = 'confirm_order' | 'ship_order' | 'deliver_order' | 'cancel_order';

export function useOrderAction(orgId: string, orderId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: OrderAction) => {
      const { error } = await getSupabase().rpc(action, { p_order: orderId });
      if (error) throw error;
    },
    // Order actions reserve/consume stock: refresh both.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: orderKeys.all(orgId) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.all(orgId) }),
      ]),
  });
}

const messages: Partial<Record<string, string>> = {
  'orders.not_found': 'Pedido não encontrado ou sem permissão para esta ação.',
  'orders.sellers_only': 'Pedidos são criados por empresas vendedoras.',
  'orders.invalid': 'Pedido inválido. Revise os dados.',
  'orders.invalid_items':
    'Itens inválidos: verifique quantidades e não repita o mesmo item. Produtos com variações são vendidos pela variação.',
  'orders.item_unavailable': 'Um dos itens não está ativo. Ative o produto/variação ou remova-o.',
  'orders.invalid_discount': 'O desconto é maior que o valor do pedido.',
  'orders.invalid_status': 'O pedido mudou de situação. Atualize a página.',
  'orders.insufficient_stock': 'Estoque insuficiente para confirmar o pedido.',
  'orders.source_unavailable':
    'Um produto de fornecedor não está mais disponível no catálogo. Remova-o ou cancele o pedido.',
  'orders.awaiting_supplier': 'Aguardando o envio do fornecedor para marcar o pedido como enviado.',
  'orders.supplier_already_shipped':
    'O fornecedor já enviou: o pedido não pode mais ser cancelado.',
  'orders.reservation_mismatch': 'Reserva de estoque inconsistente. Contate o suporte.',
  'orders.checkout_managed':
    'Pedido do checkout: confirmação, cancelamento e pagamento seguem o Mercado Pago.',
};

export function orderErrorMessage(error: unknown): string {
  const { message, code } = (error ?? {}) as { message?: unknown; code?: unknown };
  if (typeof message === 'string' && messages[message]) return messages[message];
  if (code === '23514') return 'Dados do cliente ou do endereço inválidos. Revise os campos.';
  if (typeof message === 'string' && message.startsWith('org.')) return orgErrorMessage(error);
  return productErrorMessage(error);
}
