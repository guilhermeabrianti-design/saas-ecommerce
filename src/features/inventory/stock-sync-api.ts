import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import type { StockCsvRow, StockSyncSummary } from './stock-sync';

const summarySchema = z.object({
  updated: z.number().int(),
  unchanged: z.number().int(),
  unknown_count: z.number().int(),
  unknown: z
    .array(z.string())
    .nullable()
    .transform((v) => v ?? []),
  invalid: z
    .array(z.string())
    .nullable()
    .transform((v) => v ?? []),
  clamped: z
    .array(z.string())
    .nullable()
    .transform((v) => v ?? []),
});

const erpConnectionSchema = z.object({
  id: z.uuid(),
  provider: z.enum(['bling', 'tiny']),
  name: z.string(),
  status: z.enum(['active', 'paused', 'disconnected']),
  last_sync_at: z.string().nullable(),
  last_sync_summary: z.record(z.string(), z.unknown()).nullable(),
});
export type ErpConnection = z.infer<typeof erpConnectionSchema>;

export const stockSyncKeys = {
  erp: (orgId: string) => ['erp-connections', orgId] as const,
};

/** Atualiza o estoque pelas linhas da planilha; devolve o resumo. */
export function useBulkSetStock(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (rows: StockCsvRow[]): Promise<StockSyncSummary> => {
      const { data, error } = await getSupabase().rpc('bulk_set_stock', {
        p_org: orgId,
        p_rows: rows,
      });
      if (error) throw error;
      return summarySchema.parse(data);
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['inventory'] }),
        queryClient.invalidateQueries({ queryKey: ['products'] }),
      ]),
  });
}

/** Itens de estoque próprio para o modelo da planilha. */
export async function fetchStockTemplateItems(orgId: string) {
  const supabase = getSupabase();
  const [levels, imported] = await Promise.all([
    supabase
      .from('inventory_levels')
      .select('sku, on_hand, product_id')
      .eq('organization_id', orgId)
      .order('sku')
      .limit(5000),
    // Importados do catálogo usam o estoque do fornecedor: ficam fora do modelo.
    supabase
      .from('products')
      .select('id')
      .eq('organization_id', orgId)
      .not('source_listing_id', 'is', null),
  ]);
  if (levels.error) throw levels.error;
  if (imported.error) throw imported.error;
  const skip = new Set((imported.data ?? []).map((p) => p.id as string));
  return z
    .array(z.object({ sku: z.string(), on_hand: z.number().int(), product_id: z.uuid() }))
    .parse(levels.data)
    .filter((l) => !skip.has(l.product_id));
}

export function useErpConnections(orgId: string) {
  return useQuery({
    queryKey: stockSyncKeys.erp(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('integration_connections')
        .select('id, provider, name, status, last_sync_at, last_sync_summary')
        .eq('organization_id', orgId)
        .in('provider', ['bling', 'tiny'])
        .neq('status', 'disconnected');
      if (error) throw error;
      return z.array(erpConnectionSchema).parse(data);
    },
  });
}

const erpMessages: Record<string, string> = {
  not_configured: 'A integração com este ERP ainda não foi configurada na plataforma.',
  invalid_token: 'O Tiny recusou o token. Confira em Configurações › API do Tiny.',
  forbidden: 'Só proprietário ou administrador conecta o ERP.',
  rate_limited: 'Muitas sincronizações seguidas. Aguarde alguns minutos.',
  disconnected: 'A conexão foi encerrada. Conecte de novo.',
  not_found: 'Conexão não encontrada.',
  invalid_body: 'Dados inválidos. Revise os campos.',
};

export class ErpError extends Error {}

async function invoke(path: string, body: Record<string, unknown>) {
  const { data, error } = await getSupabase().functions.invoke(path, { body });
  if (error) {
    let code: string | null = null;
    if (error instanceof FunctionsHttpError) {
      code =
        ((await error.context.json().catch(() => null)) as { error?: string } | null)?.error ??
        null;
    }
    throw new ErpError((code && erpMessages[code]) || 'Não foi possível concluir. Tente de novo.');
  }
  return (data ?? {}) as Record<string, unknown>;
}

export function useConnectBling(orgId: string) {
  return useMutation({
    mutationFn: async (name: string) => {
      const data = await invoke('erp/connect-bling', { organization_id: orgId, name });
      const url = String(data.url ?? '');
      if (!url.startsWith('https://www.bling.com.br/')) throw new ErpError('Resposta inesperada.');
      window.location.assign(url);
    },
  });
}

export function useConnectTiny(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; token: string }) =>
      invoke('erp/connect-tiny', { organization_id: orgId, ...input }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: stockSyncKeys.erp(orgId) }),
  });
}

export function useSyncErp(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) => invoke('erp/sync', { connection_id: connectionId }),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: stockSyncKeys.erp(orgId) }),
        queryClient.invalidateQueries({ queryKey: ['inventory'] }),
        queryClient.invalidateQueries({ queryKey: ['products'] }),
      ]),
  });
}

export function useDisconnectErp(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) => {
      const { error } = await getSupabase().rpc('set_connection_status', {
        p_connection: connectionId,
        p_status: 'disconnected',
      });
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: stockSyncKeys.erp(orgId) }),
  });
}
