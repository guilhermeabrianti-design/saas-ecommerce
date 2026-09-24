import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { signImagePaths } from '@/features/products/images';
import { getSupabase } from '@/lib/supabase';
import {
  approvalStatuses,
  moderationListingSchema,
  supplierReviewSchema,
  type ApprovalStatus,
  type ListingModeration,
  type ModerationAction,
} from './moderation';

export const MODERATION_PAGE_SIZE = 10;

export const moderationKeys = {
  all: ['moderation'] as const,
  suppliers: (status: ApprovalStatus | null, page: number) =>
    ['moderation', 'suppliers', status, page] as const,
  listings: (status: ListingModeration | null, search: string, page: number) =>
    ['moderation', 'listings', status, search, page] as const,
  approval: (orgId: string) => ['supplier-approval', orgId] as const,
};

async function invalidate(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: moderationKeys.all }),
    queryClient.invalidateQueries({ queryKey: ['admin'] }),
  ]);
}

export function useSupplierReviews(status: ApprovalStatus | null, page: number) {
  return useQuery({
    queryKey: moderationKeys.suppliers(status, page),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_supplier_reviews', {
        p_status: status,
        p_limit: MODERATION_PAGE_SIZE,
        p_offset: (page - 1) * MODERATION_PAGE_SIZE,
      });
      if (error) throw error;
      const items = z.array(supplierReviewSchema).parse(data);
      return { items, total: items[0]?.total_count ?? 0 };
    },
  });
}

export function useModerationListings(
  status: ListingModeration | null,
  search: string,
  page: number,
) {
  return useQuery({
    queryKey: moderationKeys.listings(status, search, page),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_moderation_listings', {
        p_status: status,
        p_search: search.trim().slice(0, 100),
        p_limit: MODERATION_PAGE_SIZE,
        p_offset: (page - 1) * MODERATION_PAGE_SIZE,
      });
      if (error) throw error;
      const rows = z.array(moderationListingSchema).parse(data);
      // Até 4 imagens por anúncio na fila.
      const paths = rows.flatMap((r) => r.image_paths.slice(0, 4));
      const urls = await signImagePaths(paths);
      let i = 0;
      const items = rows.map((r) => ({
        ...r,
        image_urls: r.image_paths.slice(0, 4).map(() => urls[i++] ?? null),
      }));
      return { items, total: rows[0]?.total_count ?? 0 };
    },
  });
}

export function useReviewSupplier() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (v: { orgId: string; approve: boolean; reason: string }) => {
      const { error } = await getSupabase().rpc('admin_review_supplier', {
        p_org: v.orgId,
        p_approve: v.approve,
        p_reason: v.reason.trim() || null,
      });
      if (error) throw error;
    },
    onSettled: () => invalidate(queryClient),
  });
}

export function useModerateListing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (v: { listingId: string; action: ModerationAction; reason: string }) => {
      const { error } = await getSupabase().rpc('admin_moderate_listing', {
        p_listing: v.listingId,
        p_action: v.action,
        p_reason: v.reason.trim() || null,
      });
      if (error) throw error;
    },
    onSettled: () => invalidate(queryClient),
  });
}

export function useUpdateListingContent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      listingId: string;
      name: string;
      description: string;
      categoryId: string | null;
    }) => {
      const { error } = await getSupabase().rpc('admin_update_listing_content', {
        p_listing: v.listingId,
        p_name: v.name.trim(),
        p_description: v.description,
        p_category: v.categoryId,
      });
      if (error) throw error;
    },
    onSettled: () => invalidate(queryClient),
  });
}

// ---------------------------------------------------------------------
// Fornecedor
// ---------------------------------------------------------------------
const approvalSchema = z.object({
  approval_status: z.enum(approvalStatuses),
  approval_reason: z.string().nullable(),
});

/** Situação de aprovação da organização fornecedora (RLS: membros leem). */
export function useSupplierApproval(orgId: string | null) {
  return useQuery({
    queryKey: moderationKeys.approval(orgId ?? ''),
    enabled: orgId !== null,
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('organizations')
        .select('approval_status, approval_reason')
        .eq('id', orgId!)
        .single();
      if (error) throw error;
      return approvalSchema.parse(data);
    },
  });
}

export function useRequestSupplierReview(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error } = await getSupabase().rpc('request_supplier_review', { p_org: orgId });
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: moderationKeys.approval(orgId) }),
  });
}

export function useResubmitListing(onDone: () => Promise<unknown>) {
  return useMutation({
    mutationFn: async (listingId: string) => {
      const { error } = await getSupabase().rpc('resubmit_catalog_listing', {
        p_listing: listingId,
      });
      if (error) throw error;
    },
    onSettled: onDone,
  });
}
