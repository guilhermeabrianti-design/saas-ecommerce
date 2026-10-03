import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import { adminOverviewSchema, overviewSchema, type AdminPackage } from './sponsorships';

export const sponsorshipKeys = {
  overview: (orgId: string) => ['sponsorships', orgId] as const,
  admin: ['sponsorships-admin'] as const,
};

export function useSponsorshipOverview(orgId: string) {
  return useQuery({
    queryKey: sponsorshipKeys.overview(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('sponsorship_overview', { p_org: orgId });
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

export function useBuySponsorship() {
  return useMutation({
    mutationFn: async (input: { listingId: string; packageId: string }) => {
      const data = await invokeBilling('sponsor', {
        listing_id: input.listingId,
        package_id: input.packageId,
      });
      return z.object({ checkout_url: z.url() }).parse(data).checkout_url;
    },
  });
}

/** Volta do Mercado Pago: relê o pagamento sem esperar a notificação. */
export function useSponsorshipReturn(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (paymentId: string) => {
      await invokeBilling('sponsor-return', { payment_id: paymentId });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: sponsorshipKeys.overview(orgId) }),
  });
}

/** Vendedor abriu um anúncio: conta para o patrocínio no ar (falha não importa). */
export function useRecordSponsoredView(listingId: string) {
  useEffect(() => {
    if (!listingId) return;
    try {
      void getSupabase()
        .rpc('sponsorship_record_view', { p_listing: listingId })
        .then(
          () => undefined,
          () => undefined,
        );
    } catch {
      // Supabase não configurado (ex.: testes): nada a contar.
    }
  }, [listingId]);
}

export function useAdminSponsorships() {
  return useQuery({
    queryKey: sponsorshipKeys.admin,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_sponsorship_overview');
      if (error) throw error;
      return adminOverviewSchema.parse(data);
    },
  });
}

export type PackageInput = Pick<
  AdminPackage,
  'placement' | 'name' | 'duration_days' | 'price_cents' | 'max_active' | 'active' | 'position'
> & { id: string | null };

export function useSavePackage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (p: PackageInput) => {
      const { error } = await getSupabase().rpc('admin_save_sponsorship_package', {
        p_id: p.id,
        p_placement: p.placement,
        p_name: p.name,
        p_duration_days: p.duration_days,
        p_price_cents: p.price_cents,
        p_max_active: p.max_active,
        p_active: p.active,
        p_position: p.position,
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sponsorshipKeys.admin }),
  });
}
