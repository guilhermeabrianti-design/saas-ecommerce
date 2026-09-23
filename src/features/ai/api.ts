import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';

const usageSchema = z.object({ used: z.number().int(), daily_limit: z.number().int() });
const resultSchema = z.object({ description: z.string().min(1), remaining: z.number().int() });

export const aiKeys = {
  usage: (orgId: string) => ['ai-usage', orgId] as const,
};

const messages: Record<string, string> = {
  forbidden: 'Somente proprietários e administradores usam a IA.',
  product_not_found: 'Produto não encontrado. Recarregue a página.',
  quota_exceeded: 'O limite diário de gerações da organização foi atingido. Tente amanhã.',
  not_configured: 'A IA não está configurada neste ambiente. Contate o suporte.',
  ai_busy: 'A IA está ocupada no momento. Tente novamente em instantes.',
  refused: 'A IA não pôde gerar uma descrição para este produto. Escreva manualmente.',
  empty_response: 'A IA não devolveu texto. Tente novamente.',
  unauthorized: 'Sua sessão expirou. Entre novamente.',
};

const FALLBACK = 'Não foi possível gerar a descrição. Tente novamente.';

export function aiErrorMessage(code: string | undefined | null): string {
  return (code && messages[code]) || FALLBACK;
}

/** O código estável vem no corpo JSON de respostas não-2xx da função. */
async function errorCodeOf(error: unknown): Promise<string | undefined> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body: unknown = await error.context.json();
      const code = (body as { error?: unknown } | null)?.error;
      return typeof code === 'string' ? code : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export class AiError extends Error {
  constructor(readonly code: string | undefined) {
    super(aiErrorMessage(code));
  }
}

export function useAiUsage(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: aiKeys.usage(orgId),
    enabled,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('ai_usage_today', { p_org: orgId });
      if (error) throw error;
      return z.array(usageSchema).parse(data)[0] ?? null;
    },
  });
}

/** Pede uma sugestão de descrição; o texto NÃO é salvo (a pessoa revisa e salva). */
export function useGenerateDescription(orgId: string, productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await getSupabase().functions.invoke('ai', {
        body: { organization_id: orgId, product_id: productId },
      });
      if (error) throw new AiError(await errorCodeOf(error));
      const parsed = resultSchema.safeParse(data);
      if (!parsed.success) throw new AiError(undefined);
      return parsed.data;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: aiKeys.usage(orgId) }),
  });
}
