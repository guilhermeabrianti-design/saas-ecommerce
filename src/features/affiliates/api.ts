import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import {
  adminReferralSchema,
  linkTargetSchema,
  normalizeCode,
  programSchema,
  referralOverviewSchema,
  referralSummarySchema,
  storeSchema,
  visitorId,
  type Attribution,
  type ReferralSettings,
} from './affiliates';

export const affiliateKeys = {
  all: (orgId: string) => ['affiliates', orgId] as const,
  referral: (orgId: string) => ['referral', orgId] as const,
  store: (code: string) => ['public-store', code] as const,
  link: (code: string) => ['public-link', code] as const,
  settings: ['referral-settings'] as const,
  admin: ['referral-admin'] as const,
  adminOverview: ['referral-admin', 'overview'] as const,
  adminList: (page: number) => ['referral-admin', 'list', page] as const,
};

async function notFoundToNull(error: unknown): Promise<null> {
  if (error instanceof FunctionsHttpError && error.context.status === 404) return null;
  throw error;
}

// ---------------------------------------------------------------------
// Público (sem conta)
// ---------------------------------------------------------------------

export function usePublicStore(code: string) {
  return useQuery({
    queryKey: affiliateKeys.store(code),
    retry: false,
    // URLs das fotos valem 1 hora.
    staleTime: 30 * 60_000,
    queryFn: async () => {
      const { data, error } = await getSupabase().functions.invoke(
        `checkout/store/${encodeURIComponent(normalizeCode(code))}`,
        { method: 'GET' },
      );
      if (error) return notFoundToNull(error);
      return storeSchema.parse(data).store;
    },
  });
}

export async function fetchLinkTarget(code: string) {
  const { data, error } = await getSupabase().functions.invoke(
    `checkout/link/${encodeURIComponent(normalizeCode(code))}`,
    { method: 'GET' },
  );
  if (error) return notFoundToNull(error);
  return linkTargetSchema.parse(data).link;
}

/** Conta o acesso. Falha aqui nunca atrapalha quem está comprando. */
export async function recordVisit(attribution: Attribution) {
  try {
    await getSupabase().functions.invoke('checkout/visit', {
      body: { ...attribution, visitor_id: visitorId() },
    });
  } catch {
    // sem contagem, segue a navegação
  }
}

// ---------------------------------------------------------------------
// Vendedor: código da empresa (endereço da loja e código de indicação)
// ---------------------------------------------------------------------

export function useSetPublicCode(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) => {
      const { data, error } = await getSupabase().rpc('set_public_code', {
        p_org: orgId,
        p_code: code,
      });
      if (error) throw error;
      return z.string().parse(data);
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: affiliateKeys.all(orgId) }),
        queryClient.invalidateQueries({ queryKey: affiliateKeys.referral(orgId) }),
      ]),
  });
}

// ---------------------------------------------------------------------
// Indicação
// ---------------------------------------------------------------------

export function useReferralSummary(orgId: string) {
  return useQuery({
    queryKey: affiliateKeys.referral(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('referral_summary', { p_org: orgId });
      if (error) throw error;
      return referralSummarySchema.parse(data);
    },
  });
}

export function useApplyReferralCode(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) => {
      const { error } = await getSupabase().rpc('apply_referral_code', {
        p_org: orgId,
        p_code: code,
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: affiliateKeys.referral(orgId) }),
  });
}

// ---------------------------------------------------------------------
// Equipe
// ---------------------------------------------------------------------

export const REFERRALS_PAGE_SIZE = 50;

export function useReferralSettings() {
  return useQuery({
    queryKey: affiliateKeys.settings,
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('referral_settings')
        .select('enabled, reward_cents, min_sale_cents, window_days')
        .single();
      if (error) throw error;
      return programSchema.parse(data);
    },
  });
}

export function useSaveReferralSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (s: ReferralSettings) => {
      const { error } = await getSupabase().rpc('admin_save_referral_settings', {
        p_enabled: s.enabled,
        p_reward_cents: s.reward_cents,
        p_min_sale_cents: s.min_sale_cents,
        p_window_days: s.window_days,
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: affiliateKeys.settings }),
  });
}

export function useReferralsOverview() {
  return useQuery({
    queryKey: affiliateKeys.adminOverview,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_referrals_overview');
      if (error) throw error;
      return referralOverviewSchema.parse(data);
    },
  });
}

export function useAdminReferrals(page: number) {
  return useQuery({
    queryKey: affiliateKeys.adminList(page),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_referrals', {
        p_limit: REFERRALS_PAGE_SIZE,
        p_offset: (page - 1) * REFERRALS_PAGE_SIZE,
      });
      if (error) throw error;
      return z.array(adminReferralSchema).parse(data);
    },
  });
}
