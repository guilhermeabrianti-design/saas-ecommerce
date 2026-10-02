import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Provider } from '@/features/integrations/schemas';
import { getSupabase } from '@/lib/supabase';
import { parseBRL } from '@/utils/money';
import { channelConfigSchema, type ChannelForm } from './channels';
import {
  mlCategorySchema,
  mlPublishErrorMessage,
  mlSuggestionSchema,
  type SavedAttribute,
} from './ml-publish';

export const channelKeys = {
  product: (productId: string) => ['channel-configs', productId] as const,
  mlCategory: (categoryId: string) => ['ml-category', categoryId] as const,
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

export function useSaveMlAttributes(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      attributes: SavedAttribute[];
      variationMap: Record<string, string>;
    }) => {
      const { error } = await getSupabase().rpc('save_ml_listing_attributes', {
        p_product: productId,
        p_attributes: args.attributes,
        p_variation_map: args.variationMap,
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: channelKeys.product(productId) }),
  });
}

/** Erro da Edge Function com mensagem pronta para a tela. */
export class MlRequestError extends Error {
  constructor(
    message: string,
    readonly messages: string[] = [],
  ) {
    super(message);
  }
}

async function invokeMl(path: string, body: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await getSupabase().functions.invoke(`mercadolivre/${path}`, { body });
  if (!error) return data;
  type ErrorBody = { error?: string; message?: string; messages?: unknown };
  const parsed: ErrorBody | null =
    error instanceof FunctionsHttpError
      ? ((await error.context.json().catch(() => null)) as ErrorBody | null)
      : null;
  const list: unknown[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const messages = list.filter((m): m is string => typeof m === 'string');
  throw new MlRequestError(
    messages.length
      ? 'O Mercado Livre recusaria este anúncio:'
      : mlPublishErrorMessage(parsed?.error ?? null, parsed?.message ?? null),
    messages,
  );
}

export function useMlCategorySuggestions() {
  return useMutation({
    mutationFn: async (q: string) => {
      const data = await invokeMl('categories', { q });
      return z.object({ suggestions: z.array(mlSuggestionSchema) }).parse(data).suggestions;
    },
  });
}

export function useMlCategory(categoryId: string | null) {
  return useQuery({
    queryKey: channelKeys.mlCategory(categoryId ?? ''),
    enabled: Boolean(categoryId),
    staleTime: 60 * 60 * 1000,
    retry: false,
    queryFn: async () =>
      mlCategorySchema.parse(await invokeMl('category', { category_id: categoryId })),
  });
}

const publishResultSchema = z.object({
  ok: z.literal(true),
  status: z.string(),
  external_id: z.string().optional(),
  url: z.string().nullable().optional(),
  skipped: z.array(z.string()).optional(),
});

export function useMlPublish(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: 'publish' | 'pause' | 'activate') =>
      publishResultSchema.parse(await invokeMl('publish', { product_id: productId, action })),
    // Sucesso ou falha: o estado gravado no banco muda.
    onSettled: () => queryClient.invalidateQueries({ queryKey: channelKeys.product(productId) }),
  });
}
