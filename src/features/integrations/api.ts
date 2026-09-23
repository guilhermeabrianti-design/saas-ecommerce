import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import { orderKeys } from '@/features/orders/api';
import { orgErrorMessage } from '@/features/organizations/errors';
import { getSupabase } from '@/lib/supabase';
import {
  connectionStatuses,
  eventStatuses,
  providers,
  type ConnectionFormValues,
  type ConnectionStatus,
  type LinkFormValues,
} from './schemas';

const connectionSchema = z.object({
  id: z.uuid(),
  provider: z.enum(providers),
  name: z.string(),
  external_account_id: z.string(),
  status: z.enum(connectionStatuses),
  last_event_at: z.string().nullable(),
  created_at: z.string(),
});

const linkRowSchema = z.object({
  id: z.uuid(),
  inventory_item_id: z.uuid(),
  external_id: z.string(),
  sync_stock: z.boolean(),
  last_pushed_available: z.number().int().nullable(),
  last_pushed_at: z.string().nullable(),
});

const levelSchema = z.object({
  id: z.uuid(),
  sku: z.string(),
  product_name: z.string(),
  attributes: z.record(z.string(), z.string()).nullable(),
  available: z.number().int(),
});

const eventSchema = z.object({
  id: z.uuid(),
  direction: z.enum(['inbound', 'outbound']),
  kind: z.string(),
  external_id: z.string().nullable(),
  status: z.enum(eventStatuses),
  message: z.string().nullable(),
  // O payload (dados do cliente) não sai do banco: só o indicador de que dá para reprocessar.
  retryable: z.boolean(),
  created_at: z.string(),
});

const sellableItemSchema = z.object({
  id: z.uuid(),
  sku: z.string(),
  product_name: z.string(),
  attributes: z.record(z.string(), z.string()).nullable(),
});

export type Connection = z.infer<typeof connectionSchema>;
export type ListingLink = z.infer<typeof linkRowSchema> & {
  item: z.infer<typeof levelSchema> | null;
};
export type IntegrationEvent = z.infer<typeof eventSchema>;
export type SellableItem = z.infer<typeof sellableItemSchema>;

export const integrationKeys = {
  all: (orgId: string) => ['integrations', orgId] as const,
  list: (orgId: string) => ['integrations', orgId, 'list'] as const,
  detail: (orgId: string, id: string) => ['integrations', orgId, 'detail', id] as const,
  links: (orgId: string, id: string) => ['integrations', orgId, 'links', id] as const,
  events: (orgId: string, id: string) => ['integrations', orgId, 'events', id] as const,
  sellable: (orgId: string) => ['integrations', orgId, 'sellable'] as const,
};

const CONNECTION_COLUMNS =
  'id, provider, name, external_account_id, status, last_event_at, created_at';

export function useConnections(orgId: string) {
  return useQuery({
    queryKey: integrationKeys.list(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('integration_connections')
        .select(CONNECTION_COLUMNS)
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return z.array(connectionSchema).parse(data);
    },
  });
}

export function useConnection(orgId: string, id: string) {
  return useQuery({
    queryKey: integrationKeys.detail(orgId, id),
    queryFn: async () => {
      if (!z.uuid().safeParse(id).success) return null;
      const { data, error } = await getSupabase()
        .from('integration_connections')
        .select(CONNECTION_COLUMNS)
        .eq('organization_id', orgId)
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return data ? connectionSchema.parse(data) : null;
    },
  });
}

export function useListingLinks(orgId: string, connectionId: string) {
  return useQuery({
    queryKey: integrationKeys.links(orgId, connectionId),
    queryFn: async () => {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('listing_links')
        .select(
          'id, inventory_item_id, external_id, sync_stock, last_pushed_available, last_pushed_at',
        )
        .eq('organization_id', orgId)
        .eq('connection_id', connectionId)
        .order('external_id');
      if (error) throw error;
      const links = z.array(linkRowSchema).parse(data);
      if (links.length === 0) return [];

      // `inventory_levels` é uma visão: sem relação declarada para embed, então buscamos à parte.
      const { data: levels, error: levelsError } = await supabase
        .from('inventory_levels')
        .select('id, sku, product_name, attributes, available')
        .eq('organization_id', orgId)
        .in(
          'id',
          links.map((l) => l.inventory_item_id),
        );
      if (levelsError) throw levelsError;
      const byId = new Map(
        z
          .array(levelSchema)
          .parse(levels)
          .map((l) => [l.id, l]),
      );
      return links.map((l) => ({ ...l, item: byId.get(l.inventory_item_id) ?? null }));
    },
  });
}

export function useIntegrationEvents(orgId: string, connectionId: string) {
  return useQuery({
    queryKey: integrationKeys.events(orgId, connectionId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('integration_events')
        .select('id, direction, kind, external_id, status, message, retryable, created_at')
        .eq('organization_id', orgId)
        .eq('connection_id', connectionId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return z.array(eventSchema).parse(data);
    },
  });
}

/** Itens de estoque próprio que podem ser vinculados (sem dropshipping, ativos). */
export function useSellableItems(orgId: string) {
  return useQuery({
    queryKey: integrationKeys.sellable(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('inventory_levels')
        .select('id, sku, product_name, attributes')
        .eq('organization_id', orgId)
        .eq('is_dropship', false)
        .eq('is_active', true)
        .order('product_name')
        .order('sku')
        .limit(500);
      if (error) throw error;
      return z.array(sellableItemSchema).parse(data);
    },
  });
}

function useInvalidate(orgId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: integrationKeys.all(orgId) });
}

export function useCreateConnection(orgId: string) {
  const invalidate = useInvalidate(orgId);
  return useMutation({
    mutationFn: async (v: ConnectionFormValues) => {
      const { data, error } = await getSupabase().rpc('create_connection', {
        p_org: orgId,
        p_provider: v.provider,
        p_name: v.name,
        p_external_account_id: v.externalAccountId,
        p_secret: v.secret,
      });
      if (error) throw error;
      return z.uuid().parse(data);
    },
    onSuccess: invalidate,
  });
}

export function useSetConnectionStatus(orgId: string, connectionId: string) {
  const invalidate = useInvalidate(orgId);
  return useMutation({
    mutationFn: async (status: ConnectionStatus) => {
      const { error } = await getSupabase().rpc('set_connection_status', {
        p_connection: connectionId,
        p_status: status,
      });
      if (error) throw error;
    },
    onSettled: invalidate,
  });
}

export function useRotateSecret(connectionId: string) {
  return useMutation({
    mutationFn: async (secret: string) => {
      const { error } = await getSupabase().rpc('rotate_connection_secret', {
        p_connection: connectionId,
        p_secret: secret,
      });
      if (error) throw error;
    },
  });
}

export function useLinkListing(orgId: string, connectionId: string) {
  const invalidate = useInvalidate(orgId);
  return useMutation({
    mutationFn: async (v: LinkFormValues) => {
      const { error } = await getSupabase().rpc('link_listing', {
        p_connection: connectionId,
        p_inventory_item: v.inventoryItemId,
        p_external_id: v.externalId,
        p_sync_stock: v.syncStock,
      });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

export function useUnlinkListing(orgId: string) {
  const invalidate = useInvalidate(orgId);
  return useMutation({
    mutationFn: async (linkId: string) => {
      const { error } = await getSupabase().rpc('unlink_listing', { p_link: linkId });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

const retryResult = z.enum(['created', 'duplicate', 'unmapped', 'invalid', 'inactive']);
export type RetryResult = z.infer<typeof retryResult>;

export function useRetryEvent(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (eventId: string) => {
      const { data, error } = await getSupabase().rpc('retry_integration_event', {
        p_event: eventId,
      });
      if (error) throw error;
      return retryResult.parse(data);
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: integrationKeys.all(orgId) }),
        queryClient.invalidateQueries({ queryKey: orderKeys.all(orgId) }),
      ]),
  });
}

export const retryMessages: Record<RetryResult, string> = {
  created: 'Pedido criado como pendente.',
  duplicate: 'Este pedido já tinha sido importado.',
  unmapped: 'Ainda há SKUs sem vínculo. Vincule-os e tente de novo.',
  invalid: 'O pedido continua inválido. Veja o novo evento de erro para o motivo.',
  inactive: 'A conexão está pausada ou desconectada.',
};

const messages: Partial<Record<string, string>> = {
  'integrations.not_found': 'Conexão não encontrada ou sem permissão.',
  'integrations.sellers_only': 'Integrações são exclusivas de organizações vendedoras.',
  'integrations.provider_unavailable': 'Este marketplace ainda não pode ser conectado.',
  'integrations.disconnected': 'A conexão foi encerrada e não pode mais ser alterada.',
  'integrations.invalid_item':
    'Só é possível vincular estoque próprio e ativo (não dropshipping; produtos com variações, pela variação).',
  'integrations.not_retryable': 'Este evento não pode ser reprocessado.',
};

export function integrationErrorMessage(error: unknown): string {
  const { message, code } = (error ?? {}) as { message?: unknown; code?: unknown };
  if (typeof message === 'string' && messages[message]) return messages[message];
  if (code === '23505') return 'Já existe uma conexão ou vínculo com esse identificador.';
  if (code === '23514')
    return 'Dados inválidos. Revise os campos (o segredo precisa de 16+ caracteres).';
  return orgErrorMessage(error);
}

const credentialsStatusSchema = z.object({
  configured: z.boolean(),
  updated_at: z.string().nullable(),
});

export function useCredentialsStatus(connectionId: string) {
  return useQuery({
    queryKey: ['integrations', 'credentials', connectionId] as const,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('connection_credentials_status', {
        p_connection: connectionId,
      });
      if (error) throw error;
      return z.array(credentialsStatusSchema).parse(data)[0] ?? null;
    },
  });
}

export class CredentialsError extends Error {
  constructor(readonly code: string | undefined) {
    super(credentialsErrorMessage(code));
  }
}

/** Envia as credenciais à Edge Function, que criptografa e guarda; nada volta ao navegador. */
export function useSaveCredentials(connectionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (fields: Record<string, string>) => {
      const { error } = await getSupabase().functions.invoke('credentials', {
        body: { connection_id: connectionId, ...fields },
      });
      if (error) {
        let code: string | undefined;
        if (error instanceof FunctionsHttpError) {
          try {
            const body: unknown = await error.context.json();
            const value = (body as { error?: unknown } | null)?.error;
            code = typeof value === 'string' ? value : undefined;
          } catch {
            code = undefined;
          }
        }
        throw new CredentialsError(code);
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['integrations', 'credentials', connectionId] }),
  });
}

const credentialMessages: Record<string, string> = {
  invalid_credentials: 'Credenciais inválidas. Confira os valores copiados.',
  invalid_location: 'ID do local de estoque inválido (use só o número).',
  invalid_shop_address:
    'O endereço cadastrado nesta conexão não é válido para a API. Crie a conexão de novo com o endereço correto.',
  not_configured:
    'A criptografia de credenciais não está configurada neste ambiente. Contate o suporte.',
  not_found: 'Conexão não encontrada ou sem permissão.',
  disconnected: 'A conexão foi encerrada e não pode mais ser alterada.',
  provider_unavailable: 'Este marketplace ainda não aceita credenciais.',
  unauthorized: 'Sua sessão expirou. Entre novamente.',
};

export function credentialsErrorMessage(error: unknown): string {
  const code =
    error instanceof CredentialsError ? error.code : typeof error === 'string' ? error : undefined;
  return (
    (code && credentialMessages[code]) ||
    'Não foi possível guardar as credenciais. Tente novamente.'
  );
}
