import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { orgErrorMessage } from '@/features/organizations/errors';
import { getSupabase } from '@/lib/supabase';

export const periodOptions = [
  { days: 7, label: 'Últimos 7 dias' },
  { days: 30, label: 'Últimos 30 dias' },
  { days: 90, label: 'Últimos 90 dias' },
] as const;

const n = z.number().int();

const sellerOverview = z.object({
  kind: z.literal('seller'),
  days: n,
  orders: n,
  cancelled: n,
  revenue_cents: n,
  goods_revenue_cents: n,
  goods_cost_cents: n,
  gross_profit_cents: n,
  avg_ticket_cents: n,
  units: n,
  units_without_cost: n,
  marketplace_orders: n,
  pending: n,
  confirmed: n,
  shipped: n,
  delivered: n,
  low_stock_items: n,
});

const supplierOverview = z.object({
  kind: z.literal('supplier'),
  days: n,
  orders: n,
  cancelled: n,
  wholesale_cents: n,
  avg_ticket_cents: n,
  units: n,
  awaiting_shipment: n,
  shipped: n,
  unpaid_cents: n,
  low_stock_items: n,
});

const overviewSchema = z.discriminatedUnion('kind', [sellerOverview, supplierOverview]);

const dailySchema = z.object({
  day: z.string(),
  orders: n,
  amount_cents: n,
});

const topSchema = z.object({
  sku: z.string(),
  name: z.string(),
  units: n,
  amount_cents: n,
});

export type Overview = z.infer<typeof overviewSchema>;
export type SellerOverview = z.infer<typeof sellerOverview>;
export type SupplierOverview = z.infer<typeof supplierOverview>;
export type DailyPoint = z.infer<typeof dailySchema>;
export type TopItem = z.infer<typeof topSchema>;

export const analyticsKeys = {
  overview: (orgId: string, days: number) => ['analytics', orgId, 'overview', days] as const,
  daily: (orgId: string, days: number) => ['analytics', orgId, 'daily', days] as const,
  top: (orgId: string, days: number) => ['analytics', orgId, 'top', days] as const,
};

export function useOverview(orgId: string, days: number) {
  return useQuery({
    queryKey: analyticsKeys.overview(orgId, days),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('analytics_overview', {
        p_org: orgId,
        p_days: days,
      });
      if (error) throw error;
      return overviewSchema.parse(data);
    },
  });
}

export function useDaily(orgId: string, days: number) {
  return useQuery({
    queryKey: analyticsKeys.daily(orgId, days),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('analytics_daily', {
        p_org: orgId,
        p_days: days,
      });
      if (error) throw error;
      return z.array(dailySchema).parse(data);
    },
  });
}

export function useTopItems(orgId: string, days: number) {
  return useQuery({
    queryKey: analyticsKeys.top(orgId, days),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('analytics_top_items', {
        p_org: orgId,
        p_days: days,
        p_limit: 5,
      });
      if (error) throw error;
      return z.array(topSchema).parse(data);
    },
  });
}

export function analyticsErrorMessage(error: unknown): string {
  const { message } = (error ?? {}) as { message?: unknown };
  if (message === 'analytics.invalid_period') return 'Período inválido.';
  return orgErrorMessage(error);
}

/** Altura relativa (0–100) de cada barra; o maior valor ocupa 100 e valores > 0 nunca somem. */
export function barHeights(values: number[]): number[] {
  const max = Math.max(0, ...values);
  if (max === 0) return values.map(() => 0);
  return values.map((v) => (v <= 0 ? 0 : Math.max(2, Math.round((v / max) * 100))));
}

/** "2026-09-23" → "23/09" sem passar por Date (evita deslocamento de fuso). */
export function shortDay(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}
