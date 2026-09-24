import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { AiError, aiErrorCodeOf, aiKeys } from '@/features/ai/api';
import { getSupabase } from '@/lib/supabase';
import { pricingSchema, type Channel, type GenerationKind, type PricingCosts } from './tools';

export const toolsKeys = {
  products: (orgId: string, search: string) => ['tools', orgId, 'products', search] as const,
  target: (args: TargetArgs) => ['tools', 'target', args] as const,
  simulate: (args: SimulateArgs) => ['tools', 'simulate', args] as const,
};

const productOptionSchema = z.object({
  id: z.uuid(),
  sku: z.string(),
  name: z.string(),
  price_cents: z.number().int(),
  cost_cents: z.number().int().nullable(),
});
export type ProductOption = z.infer<typeof productOptionSchema>;

/** Produtos da organização para preencher custo/preço ou alimentar a IA. */
export function useProductOptions(orgId: string, search: string) {
  return useQuery({
    queryKey: toolsKeys.products(orgId, search),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let query = getSupabase()
        .from('products')
        .select('id, sku, name, price_cents, cost_cents')
        .eq('organization_id', orgId)
        .neq('status', 'archived')
        .order('name')
        .limit(30);
      const term = search.trim().slice(0, 100);
      if (term) {
        // Vírgulas e parênteses têm significado no filtro `or` do PostgREST.
        const safe = term.replace(/[,()%*\\]/g, ' ');
        query = query.or(`name.ilike.%${safe}%,sku.ilike.%${safe}%`);
      }
      const { data, error } = await query;
      if (error) throw error;
      return z.array(productOptionSchema).parse(data);
    },
  });
}

export interface TargetArgs extends Channel, PricingCosts {
  marginBps: number;
}

export interface SimulateArgs extends Channel, PricingCosts {
  priceCents: number;
}

export function usePricingTarget(args: TargetArgs | null) {
  return useQuery({
    queryKey: toolsKeys.target(args!),
    enabled: args !== null,
    placeholderData: keepPreviousData,
    retry: false,
    queryFn: async () => {
      const a = args!;
      const { data, error } = await getSupabase().rpc('pricing_target', {
        p_provider: a.provider,
        p_listing_type: a.listingType,
        p_category: a.categoryId,
        p_cost_cents: a.costCents,
        p_shipping_cents: a.shippingCents,
        p_tax_bps: a.taxBps,
        p_anticipation_bps: a.anticipationBps,
        p_margin_bps: a.marginBps,
      });
      if (error) throw error;
      return pricingSchema.parse(data);
    },
  });
}

export function usePricingSimulation(args: SimulateArgs | null) {
  return useQuery({
    queryKey: toolsKeys.simulate(args!),
    enabled: args !== null,
    placeholderData: keepPreviousData,
    retry: false,
    queryFn: async () => {
      const a = args!;
      const { data, error } = await getSupabase().rpc('pricing_simulate', {
        p_provider: a.provider,
        p_listing_type: a.listingType,
        p_category: a.categoryId,
        p_price_cents: a.priceCents,
        p_cost_cents: a.costCents,
        p_shipping_cents: a.shippingCents,
        p_tax_bps: a.taxBps,
        p_anticipation_bps: a.anticipationBps,
      });
      if (error) throw error;
      return pricingSchema.parse(data);
    },
  });
}

const generationResultSchema = z.object({
  items: z.array(z.string().min(1)).min(1),
  remaining: z.number().int(),
});

/** Gera sugestões com IA; nada é salvo (a pessoa copia o que quiser usar). */
export function useGenerate(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (v: { productId: string; kind: GenerationKind; brief: string }) => {
      const { data, error } = await getSupabase().functions.invoke('ai', {
        body: {
          organization_id: orgId,
          product_id: v.productId,
          kind: v.kind,
          brief: v.brief.trim() || null,
        },
      });
      if (error) throw new AiError(await aiErrorCodeOf(error));
      const parsed = generationResultSchema.safeParse(data);
      if (!parsed.success) throw new AiError(undefined);
      return parsed.data;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: aiKeys.usage(orgId) }),
  });
}
