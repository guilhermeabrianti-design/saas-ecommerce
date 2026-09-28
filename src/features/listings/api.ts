import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import { channelListingSchema, stepSchema } from './listings';

export const listingKeys = {
  all: (orgId: string) => ['channel-listings', orgId] as const,
  one: (id: string) => ['channel-listing', id] as const,
  steps: (id: string) => ['channel-listing', id, 'steps'] as const,
  connections: (orgId: string) => ['channel-listings', orgId, 'connections'] as const,
  products: (orgId: string) => ['channel-listings', orgId, 'products'] as const,
};

const columns =
  'id, connection_id, product_id, title, description, price_cents, status, run_action, external_id, external_url, last_error, last_published_at, updated_at, integration_connections(name, provider), products(name, sku)';

export function useChannelListings(orgId: string) {
  return useQuery({
    queryKey: listingKeys.all(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('channel_listings')
        .select(columns)
        .eq('organization_id', orgId)
        .order('updated_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return z.array(channelListingSchema).parse(data);
    },
    // Enquanto algo está sendo enviado, a lista acompanha.
    refetchInterval: (q) => (q.state.data?.some((l) => l.status === 'publishing') ? 3000 : false),
  });
}

export function useChannelListing(id: string) {
  return useQuery({
    queryKey: listingKeys.one(id),
    queryFn: async () => {
      if (!z.uuid().safeParse(id).success) return null;
      const { data, error } = await getSupabase()
        .from('channel_listings')
        .select(columns)
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return data ? channelListingSchema.parse(data) : null;
    },
    refetchInterval: (q) => (q.state.data?.status === 'publishing' ? 1500 : false),
  });
}

/** Etapas gravadas pela Edge Function — acompanhadas em tempo quase real durante o envio. */
export function useListingSteps(id: string, running: boolean) {
  return useQuery({
    queryKey: listingKeys.steps(id),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('channel_listing_steps')
        .select('id, run_id, action, step, status, message, created_at')
        .eq('listing_id', id)
        .order('id', { ascending: false })
        .limit(100);
      if (error) throw error;
      return z.array(stepSchema).parse(data);
    },
    refetchInterval: running ? 1500 : false,
  });
}

export function usePublishableConnections(orgId: string) {
  return useQuery({
    queryKey: listingKeys.connections(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('integration_connections')
        .select('id, name, provider, status')
        .eq('organization_id', orgId)
        .in('provider', ['shopify', 'woocommerce'])
        .neq('status', 'disconnected')
        .order('name');
      if (error) throw error;
      return z
        .array(
          z.object({ id: z.uuid(), name: z.string(), provider: z.string(), status: z.string() }),
        )
        .parse(data);
    },
  });
}

export function useListableProducts(orgId: string) {
  return useQuery({
    queryKey: listingKeys.products(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('products')
        .select('id, name, sku, status, description, source_listing_id')
        .eq('organization_id', orgId)
        .neq('status', 'archived')
        .order('name')
        .limit(500);
      if (error) throw error;
      return z
        .array(
          z.object({
            id: z.uuid(),
            name: z.string(),
            sku: z.string(),
            status: z.string(),
            description: z.string().nullable(),
            source_listing_id: z.uuid().nullable(),
          }),
        )
        .parse(data);
    },
  });
}

export function useSaveListing(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string | null;
      connectionId: string | null;
      productId: string | null;
      title: string;
      description: string;
      priceCents: number | null;
    }) => {
      const { data, error } = await getSupabase().rpc('save_channel_listing', {
        p_org: orgId,
        p_listing: input.id,
        p_connection: input.connectionId,
        p_product: input.productId,
        p_title: input.title.trim(),
        p_description: input.description,
        p_price_cents: input.priceCents,
      });
      if (error) throw error;
      return z.uuid().parse(data);
    },
    onSuccess: (id) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: listingKeys.all(orgId) }),
        queryClient.invalidateQueries({ queryKey: listingKeys.one(id) }),
      ]),
  });
}

export function useDuplicateListing(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, connectionId }: { id: string; connectionId: string }) => {
      const { data, error } = await getSupabase().rpc('duplicate_channel_listing', {
        p_listing: id,
        p_connection: connectionId,
      });
      if (error) throw error;
      return z.uuid().parse(data);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: listingKeys.all(orgId) }),
  });
}

export function useDeleteListing(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await getSupabase().rpc('delete_channel_listing', { p_listing: id });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: listingKeys.all(orgId) }),
  });
}

/**
 * Publicar/pausar/reativar pela Edge Function. As etapas aparecem pela
 * tabela enquanto a chamada roda; o resultado final vem na resposta.
 */
export function useListingAction(orgId: string, id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: 'publish' | 'pause' | 'activate') => {
      // Mostra "Enviando…" já na primeira leitura.
      void queryClient.invalidateQueries({ queryKey: listingKeys.one(id) });
      const { data, error } = await getSupabase().functions.invoke('listings', {
        body: { listing_id: id, action },
      });
      if (error) {
        if (error instanceof FunctionsHttpError) {
          const body = (await error.context.json().catch(() => null)) as { error?: string } | null;
          throw { message: body?.error ?? 'unknown' };
        }
        throw error;
      }
      const result = data as { ok: boolean; error?: string };
      if (!result.ok) throw { message: result.error ?? 'unknown' };
      return result;
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: listingKeys.all(orgId) }),
        queryClient.invalidateQueries({ queryKey: listingKeys.one(id) }),
        queryClient.invalidateQueries({ queryKey: listingKeys.steps(id) }),
      ]),
  });
}
