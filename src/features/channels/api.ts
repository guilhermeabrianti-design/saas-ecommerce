import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { Provider } from '@/features/integrations/schemas';
import { getSupabase } from '@/lib/supabase';
import { parseBRL } from '@/utils/money';
import { channelConfigSchema, type ChannelForm } from './channels';

export const channelKeys = {
  product: (productId: string) => ['channel-configs', productId] as const,
};

export function useChannelConfigs(productId: string) {
  return useQuery({
    queryKey: channelKeys.product(productId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('product_channel_configs')
        .select(
          'id, product_id, provider, enabled, title, price_cents, listing_type, category_id, marketplace_category, free_shipping, updated_at',
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
