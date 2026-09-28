import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import { adminReviewSchema, reputationSchema } from './reviews';

export const REVIEWS_PAGE_SIZE = 20;

export const reviewKeys = {
  all: ['reviews'] as const,
  org: (orgId: string, page: number) => ['reviews', 'org', orgId, page] as const,
  listing: (listingId: string) => ['reviews', 'listing', listingId] as const,
  mySupplier: (orderId: string) => ['reviews', 'my-supplier', orderId] as const,
  admin: (filter: string, page: number) => ['reviews', 'admin', filter, page] as const,
};

export function useReputation(orgId: string, page = 1) {
  return useQuery({
    queryKey: reviewKeys.org(orgId, page),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('organization_reputation', {
        p_org: orgId,
        p_limit: REVIEWS_PAGE_SIZE,
        p_offset: (page - 1) * REVIEWS_PAGE_SIZE,
      });
      if (error) throw error;
      return reputationSchema.parse(data);
    },
  });
}

export function useListingSupplierReputation(listingId: string) {
  return useQuery({
    queryKey: reviewKeys.listing(listingId),
    retry: false,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('listing_supplier_reputation', {
        p_listing: listingId,
      });
      if (error) throw error;
      return reputationSchema.parse(data);
    },
  });
}

export function useReplyReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reply }: { id: string; reply: string }) => {
      const { error } = await getSupabase().rpc('reply_review', { p_review: id, p_reply: reply });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: reviewKeys.all }),
  });
}

/** Só owner/admin do vendedor (`enabled`): o banco recusa os demais. */
export function useMySupplierReviews(orderId: string, enabled: boolean) {
  return useQuery({
    queryKey: reviewKeys.mySupplier(orderId),
    enabled,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('my_supplier_reviews', { p_order: orderId });
      if (error) throw error;
      return z
        .array(
          z.object({
            supplier_order_id: z.uuid(),
            rating: z.number().int(),
            comment: z.string().nullable(),
          }),
        )
        .parse(data);
    },
  });
}

export function useReviewSupplierOrder(orderId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { supplierOrderId: string; rating: number; comment: string }) => {
      const { error } = await getSupabase().rpc('review_supplier_order', {
        p_supplier_order: input.supplierOrderId,
        p_rating: input.rating,
        p_comment: input.comment.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: reviewKeys.mySupplier(orderId) }),
  });
}

export function useAdminReviews(filter: string, page: number) {
  return useQuery({
    queryKey: reviewKeys.admin(filter, page),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_reviews', {
        p_filter: filter,
        p_limit: 50,
        p_offset: (page - 1) * 50,
      });
      if (error) throw error;
      return z.array(adminReviewSchema).parse(data);
    },
  });
}

export function useSetReviewHidden() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; hidden: boolean; reason: string | null }) => {
      const { error } = await getSupabase().rpc('admin_set_review_hidden', {
        p_review: input.id,
        p_hidden: input.hidden,
        p_reason: input.reason,
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: reviewKeys.all }),
  });
}
