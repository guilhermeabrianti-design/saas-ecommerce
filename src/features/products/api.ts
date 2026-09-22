import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import { productStatuses, type ProductPayload, type ProductStatus } from './schemas';

export const PRODUCTS_PAGE_SIZE = 25;

const productSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  sku: z.string(),
  name: z.string(),
  description: z.string(),
  brand: z.string().nullable(),
  gtin: z.string().nullable(),
  price_cents: z.number().int(),
  cost_cents: z.number().int().nullable(),
  weight_grams: z.number().int().nullable(),
  length_mm: z.number().int().nullable(),
  width_mm: z.number().int().nullable(),
  height_mm: z.number().int().nullable(),
  status: z.enum(productStatuses),
  updated_at: z.string(),
});

const listItemSchema = productSchema.pick({
  id: true,
  sku: true,
  name: true,
  brand: true,
  price_cents: true,
  status: true,
  updated_at: true,
});

export type Product = z.infer<typeof productSchema>;
export type ProductListItem = z.infer<typeof listItemSchema>;

export interface ProductFilters {
  search: string;
  status: ProductStatus | 'all';
  page: number;
}

export const productKeys = {
  all: (orgId: string) => ['products', orgId] as const,
  list: (orgId: string, filters: ProductFilters) => ['products', orgId, 'list', filters] as const,
  detail: (orgId: string, id: string) => ['products', orgId, 'detail', id] as const,
};

/**
 * Makes free text safe inside a PostgREST `or=(…ilike…)` filter: drops the
 * characters that are syntax there (`,()"\`) and the LIKE wildcards.
 */
export function sanitizeSearch(text: string): string {
  return text
    .replace(/[,()"\\%_*:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

export function useProducts(orgId: string, filters: ProductFilters) {
  return useQuery({
    queryKey: productKeys.list(orgId, filters),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const from = (filters.page - 1) * PRODUCTS_PAGE_SIZE;
      let query = getSupabase()
        .from('products')
        .select('id, sku, name, brand, price_cents, status, updated_at', { count: 'exact' })
        // RLS already limits rows to the user's organizations; this picks the active one.
        .eq('organization_id', orgId)
        .order('updated_at', { ascending: false })
        .range(from, from + PRODUCTS_PAGE_SIZE - 1);
      if (filters.status !== 'all') query = query.eq('status', filters.status);
      const term = sanitizeSearch(filters.search);
      if (term) query = query.or(`name.ilike.*${term}*,sku.ilike.*${term}*`);

      const { data, error, count } = await query;
      if (error) throw error;
      return { items: z.array(listItemSchema).parse(data), total: count ?? 0 };
    },
  });
}

export function useProduct(orgId: string, id: string) {
  return useQuery({
    queryKey: productKeys.detail(orgId, id),
    queryFn: async () => {
      // A malformed id in the URL is simply "not found" (and never reaches Postgres).
      if (!z.uuid().safeParse(id).success) return null;
      const { data, error } = await getSupabase()
        .from('products')
        .select(
          'id, organization_id, sku, name, description, brand, gtin, price_cents, cost_cents, weight_grams, length_mm, width_mm, height_mm, status, updated_at',
        )
        .eq('organization_id', orgId)
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return data ? productSchema.parse(data) : null;
    },
  });
}

export function useCreateProduct(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: ProductPayload) => {
      const { data, error } = await getSupabase()
        .from('products')
        .insert({ ...payload, organization_id: orgId })
        .select('id')
        .single();
      if (error) throw error;
      return z.object({ id: z.uuid() }).parse(data).id;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: productKeys.all(orgId) }),
  });
}

export function useUpdateProduct(orgId: string, id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: ProductPayload) => {
      const { data, error } = await getSupabase()
        .from('products')
        .update(payload)
        .eq('organization_id', orgId)
        .eq('id', id)
        .select('id');
      if (error) throw error;
      // RLS turns a forbidden update into "0 rows"; surface it instead of faking success.
      if (!data?.length) throw { message: 'org.forbidden' };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: productKeys.all(orgId) }),
  });
}

export function useDeleteProduct(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await getSupabase()
        .from('products')
        .delete()
        .eq('organization_id', orgId)
        .eq('id', id)
        .select('id');
      if (error) throw error;
      if (!data?.length) throw { message: 'products.delete_not_draft' };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: productKeys.all(orgId) }),
  });
}
