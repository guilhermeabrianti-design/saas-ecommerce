import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { listingModerations } from '@/features/moderation/moderation';
import { getSupabase } from '@/lib/supabase';
import { centsToInput, parseBRL } from '@/utils/money';

const listingSchema = z.object({
  id: z.uuid(),
  wholesale_price_cents: z.number().int(),
  suggested_price_cents: z.number().int().nullable(),
  is_published: z.boolean(),
  category_id: z.uuid().nullable(),
  moderation_status: z.enum(listingModerations),
  moderation_reason: z.string().nullable(),
});

export type CatalogListing = z.infer<typeof listingSchema>;

export const listingKey = (orgId: string, productId: string) =>
  ['products', orgId, 'catalog-listing', productId] as const;

/** The supplier's own listing for a product (RLS: supplier members only). */
export function useOwnCatalogListing(orgId: string, productId: string) {
  return useQuery({
    queryKey: listingKey(orgId, productId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('catalog_listings')
        .select(
          'id, wholesale_price_cents, suggested_price_cents, is_published, category_id, moderation_status, moderation_reason',
        )
        .eq('organization_id', orgId)
        .eq('product_id', productId)
        .maybeSingle();
      if (error) throw error;
      return data ? listingSchema.parse(data) : null;
    },
  });
}

export const listingFormSchema = z.object({
  wholesale: z
    .string()
    .trim()
    .refine((v) => parseBRL(v) !== null, { error: 'Informe o preço de atacado, ex.: 30,00' }),
  suggested: z
    .string()
    .trim()
    .refine((v) => v === '' || parseBRL(v) !== null, { error: 'Valor inválido, ex.: 79,90' }),
  isPublished: z.boolean(),
  categoryId: z.string(),
});

export type ListingFormValues = z.infer<typeof listingFormSchema>;

export function toListingFormValues(l: CatalogListing | null): ListingFormValues {
  return {
    wholesale: centsToInput(l?.wholesale_price_cents),
    suggested: centsToInput(l?.suggested_price_cents),
    isPublished: l?.is_published ?? false,
    categoryId: l?.category_id ?? '',
  };
}

export function toListingPayload(v: ListingFormValues) {
  return {
    wholesale_price_cents: parseBRL(v.wholesale)!,
    suggested_price_cents: v.suggested === '' ? null : parseBRL(v.suggested),
    is_published: v.isPublished,
    category_id: v.categoryId || null,
  };
}

export function useSaveCatalogListing(orgId: string, productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, values }: { id: string | null; values: ListingFormValues }) => {
      const payload = toListingPayload(values);
      const table = getSupabase().from('catalog_listings');
      const { data, error } = id
        ? await table.update(payload).eq('organization_id', orgId).eq('id', id).select('id')
        : await table
            .insert({ ...payload, organization_id: orgId, product_id: productId })
            .select('id');
      if (error) throw error;
      if (!data?.length) throw { message: 'org.forbidden' };
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: listingKey(orgId, productId) }),
  });
}
