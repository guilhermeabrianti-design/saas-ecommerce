import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import { providerLabels, type Provider } from '@/features/integrations/schemas';
import { getSupabase } from '@/lib/supabase';
import { parseBRL } from '@/utils/money';
import { channelConfigSchema, type ChannelForm } from './channels';
import {
  mlCategorySchema,
  mlSuggestionSchema,
  publishErrorMessage,
  type SavedAttribute,
} from './ml-publish';

export const channelKeys = {
  product: (productId: string) => ['channel-configs', productId] as const,
  category: (provider: Provider, categoryId: string) =>
    ['marketplace-category', provider, categoryId] as const,
};

export function useChannelConfigs(productId: string) {
  return useQuery({
    queryKey: channelKeys.product(productId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('product_channel_configs')
        .select(
          'id, product_id, provider, enabled, title, price_cents, listing_type, category_id, marketplace_category, free_shipping, updated_at, attributes, variation_map, external_id, external_url, publish_status, last_error, published_at',
        )
        .eq('product_id', productId);
      if (error) throw error;
      return z.array(channelConfigSchema).parse(data);
    },
  });
}

export function useSaveChannelConfig(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ provider, form }: { provider: Provider; form: ChannelForm }) => {
      const { error } = await getSupabase().rpc('save_product_channel_config', {
        p_product: productId,
        p_provider: provider,
        p_enabled: form.enabled,
        p_title: form.title.trim(),
        p_price_cents: parseBRL(form.price),
        p_listing_type: form.listingType,
        p_category: form.categoryId || null,
        p_marketplace_category: form.marketplaceCategory.trim() || null,
        p_free_shipping: form.freeShipping,
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: channelKeys.product(productId) }),
  });
}

export function useSaveListingAttributes(provider: Provider, productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      attributes: SavedAttribute[];
      variationMap: Record<string, string>;
    }) => {
      const { error } = await getSupabase().rpc('save_listing_attributes', {
        p_product: productId,
        p_provider: provider,
        p_attributes: args.attributes,
        p_variation_map: provider === 'mercadolivre' ? args.variationMap : {},
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: channelKeys.product(productId) }),
  });
}

/** Erro da Edge Function com mensagem pronta para a tela. */
export class PublishRequestError extends Error {
  constructor(
    message: string,
    readonly messages: string[] = [],
  ) {
    super(message);
  }
}

async function invokeMarketplace(
  provider: Provider,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await getSupabase().functions.invoke(`${provider}/${path}`, { body });
  if (!error) return data;
  type ErrorBody = { error?: string; message?: string; messages?: unknown };
  const parsed: ErrorBody | null =
    error instanceof FunctionsHttpError
      ? ((await error.context.json().catch(() => null)) as ErrorBody | null)
      : null;
  const list: unknown[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const messages = list.filter((m): m is string => typeof m === 'string');
  throw new PublishRequestError(
    messages.length
      ? `${provider === 'mercadolivre' ? 'O' : 'A'} ${providerLabels[provider]} recusaria este anúncio:`
      : publishErrorMessage(parsed?.error ?? null, parsed?.message ?? null, provider),
    messages,
  );
}

/** Sugestões de categoria pelo título (Shopee e TikTok Shop usam a loja conectada). */
export function useCategorySuggestions(provider: Provider, orgId: string) {
  return useMutation({
    mutationFn: async (q: string) => {
      const data = await invokeMarketplace(provider, 'categories', { q, organization_id: orgId });
      return z.object({ suggestions: z.array(mlSuggestionSchema) }).parse(data).suggestions;
    },
  });
}

export function useMarketplaceCategory(
  provider: Provider,
  orgId: string,
  categoryId: string | null,
) {
  return useQuery({
    queryKey: channelKeys.category(provider, categoryId ?? ''),
    enabled: Boolean(categoryId),
    staleTime: 60 * 60 * 1000,
    retry: false,
    queryFn: async () =>
      mlCategorySchema.parse(
        await invokeMarketplace(provider, 'category', {
          category_id: categoryId,
          organization_id: orgId,
        }),
      ),
  });
}

const publishResultSchema = z.object({
  ok: z.literal(true),
  status: z.string(),
  external_id: z.string().optional(),
  url: z.string().nullable().optional(),
  skipped: z.array(z.string()).optional(),
});

export function usePublish(provider: Provider, productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: 'publish' | 'pause' | 'activate') =>
      publishResultSchema.parse(
        await invokeMarketplace(provider, 'publish', { product_id: productId, action }),
      ),
    // Sucesso ou falha: o estado gravado no banco muda.
    onSettled: () => queryClient.invalidateQueries({ queryKey: channelKeys.product(productId) }),
  });
}
