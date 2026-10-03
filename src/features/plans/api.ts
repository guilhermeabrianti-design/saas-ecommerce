import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import { adminOverviewSchema, featuredStatusSchema, overviewSchema, type AdminPlan } from './plans';

export const planKeys = {
  overview: (orgId: string) => ['plans', orgId, 'overview'] as const,
  featured: (listingId: string) => ['plans', 'featured', listingId] as const,
  admin: ['plans-admin'] as const,
};

export function useBillingOverview(orgId: string) {
  return useQuery({
    queryKey: planKeys.overview(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('billing_overview', { p_org: orgId });
      if (error) throw error;
      return overviewSchema.parse(data);
    },
  });
}

/** Erro da Edge Function `billing`: o código estável vai em `message`. */
async function invokeBilling(path: string, body: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await getSupabase().functions.invoke(`billing/${path}`, { body });
  if (!error) return data;
  let code = 'internal';
  if (error instanceof FunctionsHttpError) {
    const parsed = (await error.context.json().catch(() => null)) as { error?: unknown } | null;
    if (typeof parsed?.error === 'string') code = parsed.error;
  }
  throw { message: code };
}

export function useSubscribe(orgId: string) {
  return useMutation({
    mutationFn: async (planId: string) => {
      const data = await invokeBilling('subscribe', { organization_id: orgId, plan_id: planId });
      return z.object({ checkout_url: z.url() }).parse(data).checkout_url;
    },
  });
}

export function useCancelSubscription(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await invokeBilling('cancel', { organization_id: orgId });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: planKeys.overview(orgId) }),
  });
}

/** Relê as assinaturas no Mercado Pago (ex.: ao voltar do pagamento). */
export function useRefreshSubscription(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await invokeBilling('refresh', { organization_id: orgId });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: planKeys.overview(orgId) }),
  });
}

export function useFeaturedStatus(listingId: string) {
  return useQuery({
    queryKey: planKeys.featured(listingId),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('listing_featured_status', {
        p_listing: listingId,
      });
      if (error) throw error;
      return featuredStatusSchema.parse(data);
    },
  });
}

export function useSetFeatured(listingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (featured: boolean) => {
      const { error } = await getSupabase().rpc('set_listing_featured', {
        p_listing: listingId,
        p_featured: featured,
      });
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: planKeys.featured(listingId) }),
  });
}

export function useAdminBilling() {
  return useQuery({
    queryKey: planKeys.admin,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_billing_overview');
      if (error) throw error;
      return adminOverviewSchema.parse(data);
    },
  });
}

export type PlanInput = Pick<
  AdminPlan,
  | 'org_kind'
  | 'name'
  | 'description'
  | 'price_cents'
  | 'ai_daily_limit'
  | 'max_products'
  | 'featured_slots'
  | 'active'
  | 'position'
> & { id: string | null };

export function useSavePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (p: PlanInput) => {
      const { error } = await getSupabase().rpc('admin_save_plan', {
        p_id: p.id,
        p_org_kind: p.org_kind,
        p_name: p.name,
        p_description: p.description,
        p_price_cents: p.price_cents,
        p_ai_daily_limit: p.ai_daily_limit,
        p_max_products: p.max_products,
        p_featured_slots: p.featured_slots,
        p_active: p.active,
        p_position: p.position,
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: planKeys.admin }),
  });
}
