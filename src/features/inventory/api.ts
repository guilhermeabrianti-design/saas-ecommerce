import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { z } from 'zod';
import { sanitizeSearch } from '@/features/products/api';
import { productStatuses } from '@/features/products/schemas';
import { getSupabase } from '@/lib/supabase';
import { inventoryReasons, type StockRequest } from './schemas';

export const INVENTORY_PAGE_SIZE = 25;

const levelSchema = z.object({
  id: z.uuid(),
  product_id: z.uuid(),
  variant_id: z.uuid().nullable(),
  sku: z.string(),
  product_name: z.string(),
  attributes: z.record(z.string(), z.string()).nullable(),
  product_status: z.enum(productStatuses),
  is_active: z.boolean(),
  on_hand: z.number().int(),
  reserved: z.number().int(),
  available: z.number().int(),
  min_quantity: z.number().int().nullable(),
  is_low: z.boolean(),
  price_cents: z.number().int(),
  is_dropship: z.boolean(),
});

const movementSchema = z.object({
  id: z.uuid(),
  quantity_delta: z.number().int(),
  on_hand_after: z.number().int(),
  reason: z.enum(inventoryReasons),
  note: z.string().nullable(),
  created_at: z.string(),
});

export type InventoryLevel = z.infer<typeof levelSchema>;
export type InventoryMovement = z.infer<typeof movementSchema>;

export interface InventoryFilters {
  search: string;
  lowOnly: boolean;
  page: number;
}

const LEVEL_COLUMNS =
  'id, product_id, variant_id, sku, product_name, attributes, product_status, is_active, on_hand, reserved, available, min_quantity, is_low, price_cents, is_dropship';

export const inventoryKeys = {
  all: (orgId: string) => ['inventory', orgId] as const,
  list: (orgId: string, f: InventoryFilters) => ['inventory', orgId, 'list', f] as const,
  item: (orgId: string, id: string) => ['inventory', orgId, 'item', id] as const,
  movements: (orgId: string, id: string) => ['inventory', orgId, 'movements', id] as const,
};

/** Estoque aparece no estoque e na lista de produtos: atualiza os dois. */
export const invalidateStock = (queryClient: QueryClient, orgId: string) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: inventoryKeys.all(orgId) }),
    queryClient.invalidateQueries({ queryKey: ['products', orgId] }),
  ]);

/** Itens de estoque de um produto (o produto ou cada variação). */
export function useProductStock(orgId: string, productId: string) {
  return useQuery({
    queryKey: [...inventoryKeys.all(orgId), 'product', productId] as const,
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('inventory_levels')
        .select(LEVEL_COLUMNS)
        .eq('organization_id', orgId)
        .eq('product_id', productId)
        .order('sku');
      if (error) throw error;
      return z.array(levelSchema).parse(data);
    },
  });
}

export function useInventoryLevels(orgId: string, filters: InventoryFilters) {
  return useQuery({
    queryKey: inventoryKeys.list(orgId, filters),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const from = (filters.page - 1) * INVENTORY_PAGE_SIZE;
      let query = getSupabase()
        .from('inventory_levels')
        .select(LEVEL_COLUMNS, { count: 'exact' })
        .eq('organization_id', orgId)
        .order('product_name')
        .order('sku')
        .range(from, from + INVENTORY_PAGE_SIZE - 1);
      if (filters.lowOnly) query = query.eq('is_low', true);
      const term = sanitizeSearch(filters.search);
      if (term) query = query.or(`product_name.ilike.*${term}*,sku.ilike.*${term}*`);

      const { data, error, count } = await query;
      if (error) throw error;
      return { items: z.array(levelSchema).parse(data), total: count ?? 0 };
    },
  });
}

export function useInventoryItem(orgId: string, id: string) {
  return useQuery({
    queryKey: inventoryKeys.item(orgId, id),
    queryFn: async () => {
      if (!z.uuid().safeParse(id).success) return null;
      const { data, error } = await getSupabase()
        .from('inventory_levels')
        .select(LEVEL_COLUMNS)
        .eq('organization_id', orgId)
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return data ? levelSchema.parse(data) : null;
    },
  });
}

/** Latest 50 movements of an item, newest first. */
export function useInventoryMovements(orgId: string, itemId: string) {
  return useQuery({
    queryKey: inventoryKeys.movements(orgId, itemId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('inventory_movements')
        .select('id, quantity_delta, on_hand_after, reason, note, created_at')
        .eq('organization_id', orgId)
        .eq('item_id', itemId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return z.array(movementSchema).parse(data);
    },
  });
}

/**
 * Applies a stock movement. `requestId` makes it idempotent: the caller keeps
 * the same id when retrying a failed/unknown attempt and only generates a new
 * one after a confirmed success.
 */
export function useStockMovement(orgId: string, itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ request, requestId }: { request: StockRequest; requestId: string }) => {
      const note = request.note || null;
      const { data, error } =
        request.kind === 'set'
          ? await getSupabase().rpc('set_stock', {
              p_item: itemId,
              p_quantity: request.quantity,
              p_note: note,
              p_request_id: requestId,
            })
          : await getSupabase().rpc('adjust_stock', {
              p_item: itemId,
              p_delta: request.delta,
              p_reason: request.reason,
              p_note: note,
              p_request_id: requestId,
            });
      if (error) throw error;
      return z.number().int().parse(data);
    },
    onSettled: () => invalidateStock(queryClient, orgId),
  });
}

export function useSetMinQuantity(orgId: string, itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (min: number | null) => {
      const { data, error } = await getSupabase()
        .from('inventory_items')
        .update({ min_quantity: min })
        .eq('organization_id', orgId)
        .eq('id', itemId)
        .select('id');
      if (error) throw error;
      if (!data?.length) throw { message: 'org.forbidden' };
    },
    onSettled: () => invalidateStock(queryClient, orgId),
  });
}
