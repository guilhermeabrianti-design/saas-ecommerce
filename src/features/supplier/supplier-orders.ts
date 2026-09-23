import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { inventoryKeys } from '@/features/inventory/api';
import { orderErrorMessage } from '@/features/orders/api';
import { supplierOrderStatuses, type SupplierOrderStatus } from '@/features/orders/schemas';
import { getSupabase } from '@/lib/supabase';

export const SUPPLIER_ORDERS_PAGE_SIZE = 25;

const listSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  status: z.enum(supplierOrderStatuses),
  recipient_name: z.string(),
  ship_city: z.string(),
  ship_state: z.string(),
  total_wholesale_cents: z.number().int(),
  created_at: z.string(),
});

const detailSchema = listSchema.extend({
  recipient_phone: z.string().nullable(),
  recipient_document: z.string().nullable(),
  ship_postal_code: z.string(),
  ship_street: z.string(),
  ship_number: z.string(),
  ship_complement: z.string().nullable(),
  ship_district: z.string(),
  carrier: z.string().nullable(),
  tracking_code: z.string().nullable(),
  shipped_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  supplier_order_items: z.array(
    z.object({
      id: z.uuid(),
      sku: z.string(),
      name: z.string(),
      attributes: z.record(z.string(), z.string()).nullable(),
      quantity: z.number().int(),
      unit_wholesale_cents: z.number().int(),
    }),
  ),
});

export type SupplierOrderListItem = z.infer<typeof listSchema>;
export type SupplierOrderDetail = z.infer<typeof detailSchema>;

const keys = {
  all: (orgId: string) => ['supplier-orders', orgId] as const,
  list: (orgId: string, status: string, page: number) =>
    ['supplier-orders', orgId, 'list', status, page] as const,
  detail: (orgId: string, id: string) => ['supplier-orders', orgId, 'detail', id] as const,
};

/** Supplier orders addressed to this (supplier) organization. */
export function useSupplierOrders(
  orgId: string,
  status: SupplierOrderStatus | 'all',
  page: number,
) {
  return useQuery({
    queryKey: keys.list(orgId, status, page),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const from = (page - 1) * SUPPLIER_ORDERS_PAGE_SIZE;
      let query = getSupabase()
        .from('supplier_orders')
        .select(
          'id, number, status, recipient_name, ship_city, ship_state, total_wholesale_cents, created_at',
          { count: 'exact' },
        )
        // RLS also lets sellers read their own supplier orders; this keeps only ours.
        .eq('organization_id', orgId)
        .order('number', { ascending: false })
        .range(from, from + SUPPLIER_ORDERS_PAGE_SIZE - 1);
      if (status !== 'all') query = query.eq('status', status);
      const { data, error, count } = await query;
      if (error) throw error;
      return { items: z.array(listSchema).parse(data), total: count ?? 0 };
    },
  });
}

export function useSupplierOrder(orgId: string, id: string) {
  return useQuery({
    queryKey: keys.detail(orgId, id),
    queryFn: async () => {
      if (!z.uuid().safeParse(id).success) return null;
      const { data, error } = await getSupabase()
        .from('supplier_orders')
        .select(
          `id, number, status, recipient_name, recipient_phone, recipient_document,
           ship_postal_code, ship_street, ship_number, ship_complement, ship_district, ship_city, ship_state,
           total_wholesale_cents, carrier, tracking_code, created_at, shipped_at, cancelled_at,
           supplier_order_items (id, sku, name, attributes, quantity, unit_wholesale_cents)`,
        )
        .eq('organization_id', orgId)
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return data ? detailSchema.parse(data) : null;
    },
  });
}

export const shipFormSchema = z.object({
  carrier: z.string().trim().min(2, 'Informe a transportadora').max(60),
  trackingCode: z.string().trim().min(4, 'Informe o código de rastreio').max(60),
});
export type ShipFormValues = z.infer<typeof shipFormSchema>;

export function useShipSupplierOrder(orgId: string, id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (v: ShipFormValues) => {
      const { error } = await getSupabase().rpc('ship_supplier_order', {
        p_supplier_order: id,
        p_carrier: v.carrier,
        p_tracking_code: v.trackingCode,
      });
      if (error) throw error;
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.all(orgId) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.all(orgId) }),
      ]),
  });
}

export const supplierOrderErrorMessage = orderErrorMessage;
