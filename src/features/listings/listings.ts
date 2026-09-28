import { z } from 'zod';
import { parseBRL } from '@/utils/money';

export const listingStatuses = ['draft', 'publishing', 'active', 'paused', 'error'] as const;
export type ListingStatus = (typeof listingStatuses)[number];

export const listingStatusLabels: Record<ListingStatus, string> = {
  draft: 'Rascunho',
  publishing: 'Enviando…',
  active: 'Ativo',
  paused: 'Pausado',
  error: 'Com erro',
};

export const listingStatusTone: Record<ListingStatus, string> = {
  draft: 'bg-surface-2 text-muted',
  publishing: 'bg-brand/10 text-brand',
  active: 'bg-success/10 text-success',
  paused: 'bg-warning/10 text-warning',
  error: 'bg-danger/10 text-danger',
};

export const providerLabels: Record<string, string> = {
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
};

export const channelListingSchema = z.object({
  id: z.uuid(),
  connection_id: z.uuid(),
  product_id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  price_cents: z.number().int().nullable(),
  status: z.enum(listingStatuses),
  run_action: z.enum(['publish', 'pause', 'activate']).nullable(),
  external_id: z.string().nullable(),
  external_url: z.string().nullable(),
  last_error: z.string().nullable(),
  last_published_at: z.string().nullable(),
  updated_at: z.string(),
  integration_connections: z.object({ name: z.string(), provider: z.string() }).nullable(),
  products: z.object({ name: z.string(), sku: z.string() }).nullable(),
});

export type ChannelListing = z.infer<typeof channelListingSchema>;

export const stepSchema = z.object({
  id: z.number().int(),
  run_id: z.uuid(),
  action: z.enum(['publish', 'pause', 'activate']),
  step: z.enum(['validate', 'credentials', 'product', 'stock', 'links', 'status', 'done']),
  status: z.enum(['ok', 'error']),
  message: z.string().nullable(),
  created_at: z.string(),
});

export type ListingStep = z.infer<typeof stepSchema>;

export const stepLabels: Record<ListingStep['step'], string> = {
  validate: 'Conferência dos dados',
  credentials: 'Credenciais da loja',
  product: 'Produto no marketplace',
  stock: 'Preço e estoque',
  links: 'Vínculo dos SKUs (pedidos e estoque)',
  status: 'Situação no marketplace',
  done: 'Conclusão',
};

export const actionLabels: Record<ListingStep['action'], string> = {
  publish: 'Publicação',
  pause: 'Pausa',
  activate: 'Reativação',
};

/** Execuções (mais recente primeiro), cada uma com suas etapas em ordem. */
export function groupRuns(steps: ListingStep[]) {
  const runs = new Map<string, ListingStep[]>();
  for (const s of [...steps].sort((a, b) => a.id - b.id)) {
    runs.set(s.run_id, [...(runs.get(s.run_id) ?? []), s]);
  }
  return [...runs.entries()]
    .map(([runId, items]) => ({
      runId,
      action: items[0]!.action,
      startedAt: items[0]!.created_at,
      finished:
        items.some((s) => s.step === 'done') ||
        items.some((s) => s.step === 'validate' && s.status === 'error'),
      ok: items.every((s) => s.status === 'ok'),
      steps: items,
    }))
    .reverse();
}

export const listingFormSchema = z.object({
  title: z
    .string()
    .trim()
    .min(2, 'Título de 2 a 255 caracteres')
    .max(255, 'Título de 2 a 255 caracteres'),
  description: z.string().max(20000, 'Máximo de 20.000 caracteres'),
  price: z.string().refine((v) => {
    if (v.trim() === '') return true;
    const cents = parseBRL(v);
    return cents != null && cents >= 1;
  }, 'Preço em reais (vazio = preço do produto)'),
});

export type ListingFormValues = z.infer<typeof listingFormSchema>;

const messages: Record<string, string> = {
  'listings.forbidden': 'Só proprietários e administradores da loja gerenciam anúncios.',
  'listings.invalid': 'Revise título, descrição e preço.',
  'listings.invalid_connection': 'Escolha uma conexão da sua loja.',
  'listings.connection_inactive': 'A conexão está pausada ou desconectada.',
  'listings.provider_unavailable': 'Este marketplace ainda não aceita publicação.',
  'listings.invalid_product': 'Produto não encontrado na sua loja.',
  'listings.already_exists': 'Este produto já tem anúncio nesta conexão.',
  'listings.not_found': 'Anúncio não encontrado.',
  'listings.busy': 'Já há uma ação em andamento neste anúncio. Aguarde terminar.',
  'listings.not_published': 'Publique o anúncio antes de pausar ou reativar.',
  'listings.already_published': 'Anúncio já publicado não pode ser apagado: pause no lugar.',
  'listings.product_inactive': 'Ative o produto no seu catálogo antes de publicar.',
  'listings.product_unavailable': 'O fornecedor tirou este produto do catálogo.',
  'listings.no_variants': 'Nenhuma variação ativa para anunciar.',
  'listings.invalid_price': 'Há variação sem preço.',
  'listings.inconsistent_options':
    'As variações precisam ter as mesmas opções (ex.: Cor e Tamanho).',
  not_configured:
    'Publicação indisponível: a chave de criptografia das credenciais não foi configurada.',
  rate_limited: 'Muitas operações seguidas. Aguarde um pouco.',
};

export function listingErrorMessage(error: unknown): string {
  const e = error as { message?: unknown; code?: unknown } | null;
  for (const key of [e?.message, e?.code]) {
    if (typeof key === 'string' && messages[key]) return messages[key];
  }
  // Mensagem já escrita para a pessoa (etapa do marketplace, conflito de SKU) aparece como veio;
  // código técnico desconhecido vira texto genérico.
  const text = typeof e?.message === 'string' ? e.message : '';
  return text && text.length <= 500 && !/^[a-z_]+(.[a-z_]+)*$/.test(text)
    ? text
    : 'Não foi possível concluir. Tente de novo.';
}
