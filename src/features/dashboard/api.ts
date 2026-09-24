import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { analyticsErrorMessage } from '@/features/analytics/api';
import { signImagePaths } from '@/features/products/images';
import { getSupabase } from '@/lib/supabase';
import { onboardingStepKeys, type Bucket } from './dashboard';

const n = z.number().int();

const onboardingSchema = z.array(z.object({ key: z.enum(onboardingStepKeys), done: z.boolean() }));

const dashboardSchema = z.object({
  days: n,
  orders: n,
  sold_cents: n,
  gross_profit_cents: n,
  units_without_cost: n,
  received_cents: n,
  receivable_cents: n,
  receivable_orders: n,
  payable_cents: n,
  payable_orders: n,
});

const seriesSchema = z.object({ period_start: z.string(), orders: n, amount_cents: n });
const channelSchema = z.object({ channel: z.string(), orders: n, amount_cents: n });

const suggestionSchema = z.object({
  listing_id: z.uuid(),
  name: z.string(),
  supplier_name: z.string(),
  wholesale_price_cents: n,
  suggested_price_cents: n,
  margin_bps: n,
  available: n,
  cover_path: z.string().nullable(),
});

export type SellerDashboard = z.infer<typeof dashboardSchema>;
export type SeriesPoint = z.infer<typeof seriesSchema>;
export type ChannelRow = z.infer<typeof channelSchema>;
export type Suggestion = z.infer<typeof suggestionSchema> & { cover_url: string | null };

export const dashboardKeys = {
  all: ['dashboard'] as const,
  onboarding: (orgId: string) => ['dashboard', orgId, 'onboarding'] as const,
  summary: (orgId: string, days: number) => ['dashboard', orgId, 'summary', days] as const,
  series: (orgId: string, days: number, bucket: Bucket) =>
    ['dashboard', orgId, 'series', days, bucket] as const,
  channels: (orgId: string, days: number) => ['dashboard', orgId, 'channels', days] as const,
  suggestions: (orgId: string) => ['dashboard', orgId, 'suggestions'] as const,
};

export function useOnboarding(orgId: string) {
  return useQuery({
    queryKey: dashboardKeys.onboarding(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('seller_onboarding', { p_org: orgId });
      if (error) throw error;
      return onboardingSchema.parse(data);
    },
  });
}

export function useSellerDashboard(orgId: string, days: number) {
  return useQuery({
    queryKey: dashboardKeys.summary(orgId, days),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('seller_dashboard', {
        p_org: orgId,
        p_days: days,
      });
      if (error) throw error;
      return dashboardSchema.parse(data);
    },
  });
}

export function useSeries(orgId: string, days: number, bucket: Bucket) {
  return useQuery({
    queryKey: dashboardKeys.series(orgId, days, bucket),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('analytics_series', {
        p_org: orgId,
        p_days: days,
        p_bucket: bucket,
      });
      if (error) throw error;
      return z.array(seriesSchema).parse(data);
    },
  });
}

export function useChannels(orgId: string, days: number) {
  return useQuery({
    queryKey: dashboardKeys.channels(orgId, days),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('analytics_channels', {
        p_org: orgId,
        p_days: days,
      });
      if (error) throw error;
      return z.array(channelSchema).parse(data);
    },
  });
}

export function useSuggestions(orgId: string) {
  return useQuery({
    queryKey: dashboardKeys.suggestions(orgId),
    queryFn: async (): Promise<Suggestion[]> => {
      const { data, error } = await getSupabase().rpc('seller_suggestions', {
        p_org: orgId,
        p_limit: 4,
      });
      if (error) throw error;
      const rows = z.array(suggestionSchema).parse(data);
      const covers = await signImagePaths(
        rows.flatMap((r) => (r.cover_path ? [r.cover_path] : [])),
      );
      let i = 0;
      return rows.map((r) => ({ ...r, cover_url: r.cover_path ? (covers[i++] ?? null) : null }));
    },
  });
}

export function dashboardErrorMessage(error: unknown): string {
  const { message } = (error ?? {}) as { message?: unknown };
  if (message === 'analytics.invalid_bucket') return 'Agrupamento inválido.';
  return analyticsErrorMessage(error);
}
