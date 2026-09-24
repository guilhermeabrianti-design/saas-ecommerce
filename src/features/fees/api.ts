import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { Provider } from '@/features/integrations/schemas';
import { getSupabase } from '@/lib/supabase';
import {
  categorySchema,
  commissionRuleSchema,
  feeRuleSchema,
  splitSchema,
  toFeeRulePayload,
  type CommissionScope,
  type FeeRuleFormValues,
} from './fees';

export const feesKeys = {
  all: ['fees'] as const,
  categories: ['fees', 'categories'] as const,
  rules: ['fees', 'rules'] as const,
  commissions: ['fees', 'commissions'] as const,
  listings: (search: string) => ['fees', 'listings', search] as const,
  estimate: (args: EstimateArgs) => ['fees', 'estimate', args] as const,
  simulate: (args: SimulateArgs) => ['fees', 'simulate', args] as const,
};

export function useCategories() {
  return useQuery({
    queryKey: feesKeys.categories,
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('categories')
        .select('id, parent_id, name, is_active');
      if (error) throw error;
      return z.array(categorySchema).parse(data);
    },
  });
}

export function useFeeRules() {
  return useQuery({
    queryKey: feesKeys.rules,
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('marketplace_fee_rules')
        .select(
          'id, provider, listing_type, label, category_id, campaign, min_unit_price_cents, max_unit_price_cents, percent_bps, fixed_cents_per_item, is_active, notes, updated_at',
        )
        .order('provider')
        .order('listing_type')
        .order('campaign', { nullsFirst: true })
        .order('min_unit_price_cents');
      if (error) throw error;
      return z.array(feeRuleSchema).parse(data);
    },
  });
}

export function useCommissionRules() {
  return useQuery({
    queryKey: feesKeys.commissions,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_list_commission_rules');
      if (error) throw error;
      return z.array(commissionRuleSchema).parse(data);
    },
  });
}

const listingOptionSchema = z.object({
  listing_id: z.uuid(),
  product_name: z.string(),
  supplier_name: z.string(),
  is_published: z.boolean(),
});

export function useAdminListingSearch(search: string) {
  return useQuery({
    queryKey: feesKeys.listings(search),
    enabled: search.trim().length >= 2,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_search_listings', {
        p_search: search.trim().slice(0, 100),
        p_limit: 20,
      });
      if (error) throw error;
      return z.array(listingOptionSchema).parse(data);
    },
  });
}

function useInvalidatingMutation<T>(fn: (vars: T) => Promise<void>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: feesKeys.all });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] });
    },
  });
}

async function rpc(name: string, args: Record<string, unknown>) {
  const { error } = await getSupabase().rpc(name, args);
  if (error) throw error;
}

export const useSaveFeeRule = () =>
  useInvalidatingMutation(({ id, values }: { id: string | null; values: FeeRuleFormValues }) =>
    rpc('admin_save_fee_rule', { p_id: id, p_rule: toFeeRulePayload(values) }),
  );

export const useSetFeeRuleActive = () =>
  useInvalidatingMutation(({ id, active }: { id: string; active: boolean }) =>
    rpc('admin_set_fee_rule_active', { p_id: id, p_active: active }),
  );

export const useSaveCommissionRule = () =>
  useInvalidatingMutation(
    ({ scope, target, bps }: { scope: CommissionScope; target: string | null; bps: number }) =>
      rpc('admin_save_commission_rule', { p_scope: scope, p_target: target, p_percent_bps: bps }),
  );

export const useDeleteCommissionRule = () =>
  useInvalidatingMutation((id: string) => rpc('admin_delete_commission_rule', { p_id: id }));

export const useSaveCategory = () =>
  useInvalidatingMutation(
    ({ id, name, parentId }: { id: string | null; name: string; parentId: string | null }) =>
      rpc('admin_save_category', { p_id: id, p_name: name.trim(), p_parent: parentId }),
  );

export const useSetCategoryActive = () =>
  useInvalidatingMutation(({ id, active }: { id: string; active: boolean }) =>
    rpc('admin_set_category_active', { p_id: id, p_active: active }),
  );

// ---------------------------------------------------------------------
// Divisão da venda (calculada no banco)
// ---------------------------------------------------------------------
export interface SplitInput {
  provider: Provider;
  listingType: string;
  campaign: string | null;
  unitPriceCents: number;
  quantity: number;
}

export interface EstimateArgs extends SplitInput {
  orgId: string;
  listingId: string;
}

export function useSplitEstimate(args: EstimateArgs | null) {
  return useQuery({
    queryKey: feesKeys.estimate(args!),
    enabled: args !== null,
    placeholderData: keepPreviousData,
    retry: false,
    queryFn: async () => {
      const a = args!;
      const { data, error } = await getSupabase().rpc('estimate_sale_split', {
        p_org: a.orgId,
        p_listing: a.listingId,
        p_provider: a.provider,
        p_listing_type: a.listingType,
        p_campaign: a.campaign,
        p_unit_price_cents: a.unitPriceCents,
        p_quantity: a.quantity,
      });
      if (error) throw error;
      return splitSchema.parse(data);
    },
  });
}

export interface SimulateArgs extends SplitInput {
  categoryId: string | null;
  supplierUnitCents: number;
}

export function useAdminSimulation(args: SimulateArgs | null) {
  return useQuery({
    queryKey: feesKeys.simulate(args!),
    enabled: args !== null,
    placeholderData: keepPreviousData,
    retry: false,
    queryFn: async () => {
      const a = args!;
      const { data, error } = await getSupabase().rpc('admin_simulate_split', {
        p_provider: a.provider,
        p_listing_type: a.listingType,
        p_campaign: a.campaign,
        p_category: a.categoryId,
        p_unit_price_cents: a.unitPriceCents,
        p_quantity: a.quantity,
        p_supplier_unit_cents: a.supplierUnitCents,
        p_seller_org: null,
      });
      if (error) throw error;
      return splitSchema.parse(data);
    },
  });
}
