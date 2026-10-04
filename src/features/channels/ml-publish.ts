import { z } from 'zod';
import type { StatusTone } from '@/components/ui/StatusDot';
import { providerLabels, type Provider } from '@/features/integrations/schemas';

/** Publicação no Mercado Livre (Fase 37), na Shopee e na TikTok Shop (Fase 44): lógica da tela. */

const valueSchema = z.object({ id: z.string(), name: z.string() });

export const mlAttributeSchema = z.object({
  id: z.string(),
  name: z.string(),
  required: z.boolean(),
  variation: z.boolean(),
  value_type: z.string(),
  values: z.array(valueSchema),
  units: z.array(valueSchema),
  hint: z.string(),
});
export type MlAttribute = z.infer<typeof mlAttributeSchema>;

export const mlCategorySchema = z.object({
  category_id: z.string(),
  name: z.string(),
  path: z.string(),
  attributes: z.array(mlAttributeSchema),
});
export type MlCategory = z.infer<typeof mlCategorySchema>;

export const mlSuggestionSchema = z.object({
  category_id: z.string(),
  category_name: z.string(),
  domain_name: z.string(),
});
export type MlSuggestion = z.infer<typeof mlSuggestionSchema>;

export const savedAttributeSchema = z.object({
  id: z.string(),
  value_id: z.string().optional(),
  value_name: z.string().optional(),
});
export type SavedAttribute = z.infer<typeof savedAttributeSchema>;

export const publishStatuses = [
  'publishing',
  'active',
  'review',
  'paused',
  'closed',
  'error',
] as const;
export type PublishStatus = (typeof publishStatuses)[number];

/** Valor escolhido na tela: da lista (value_id) ou digitado (value_name). */
export interface AttributeValue {
  value_id?: string;
  value_name?: string;
}
export type AttributeDraft = Record<string, AttributeValue>;

export function attributeDraft(saved: SavedAttribute[]): AttributeDraft {
  const draft: AttributeDraft = {};
  for (const a of saved) draft[a.id] = { value_id: a.value_id, value_name: a.value_name };
  return draft;
}

const filled = (v: AttributeValue | undefined) => Boolean(v?.value_id || v?.value_name?.trim());

/**
 * O que vai para o banco: só atributos da categoria atual com valor. Da
 * lista vai o id e o nome (o Mercado Livre aceita os dois).
 */
export function attributesPayload(draft: AttributeDraft, attrs: MlAttribute[]): SavedAttribute[] {
  const out: SavedAttribute[] = [];
  for (const a of attrs) {
    const v = draft[a.id];
    if (!filled(v)) continue;
    if (v!.value_id) {
      const name = a.values.find((x) => x.id === v!.value_id)?.name;
      out.push(
        name
          ? { id: a.id, value_id: v!.value_id, value_name: name }
          : { id: a.id, value_id: v!.value_id },
      );
    } else {
      out.push({ id: a.id, value_name: v!.value_name!.trim() });
    }
  }
  return out;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Nomes comuns daqui → atributo de variação do Mercado Livre. */
const ALIASES: Record<string, string> = {
  cor: 'COLOR',
  'cor principal': 'MAIN_COLOR',
  tamanho: 'SIZE',
  voltagem: 'VOLTAGE',
  sabor: 'FLAVOR',
};

/**
 * Mapa das variações: o que já está salvo; senão um palpite pelo nome
 * ("Cor" → COLOR), só entre atributos que aceitam variação.
 */
export function variationMapDraft(
  keys: string[],
  attrs: MlAttribute[],
  saved: Record<string, string>,
): Record<string, string> {
  const options = attrs.filter((a) => a.variation);
  const map: Record<string, string> = {};
  for (const key of keys) {
    if (saved[key] && options.some((a) => a.id === saved[key])) {
      map[key] = saved[key];
      continue;
    }
    const byName = options.find((a) => norm(a.name) === norm(key));
    const alias = ALIASES[norm(key)];
    const guess = byName?.id ?? (alias && options.some((a) => a.id === alias) ? alias : undefined);
    if (guess) map[key] = guess;
  }
  return map;
}

/**
 * Obrigatórios ainda sem valor. Marca e código de barras do produto contam
 * (a publicação preenche); atributos usados nas variações também.
 */
export function missingRequired(
  attrs: MlAttribute[],
  draft: AttributeDraft,
  product: { brand: string | null; gtin: string | null },
  variationMap: Record<string, string>,
): MlAttribute[] {
  const mapped = new Set(Object.values(variationMap));
  return attrs.filter((a) => {
    if (!a.required || filled(draft[a.id]) || mapped.has(a.id)) return false;
    if (a.id === 'BRAND' && product.brand) return false;
    if (a.id === 'GTIN' && (product.gtin || filled(draft.EMPTY_GTIN_REASON))) return false;
    return true;
  });
}

/** Chaves de atributo usadas pelas variações ativas. */
export function variantKeys(
  variants: { attributes: Record<string, string>; is_active: boolean }[],
) {
  const keys = new Set<string>();
  for (const v of variants) if (v.is_active) for (const k of Object.keys(v.attributes)) keys.add(k);
  return [...keys];
}

/** "no Mercado Livre", "na Shopee", "na TikTok Shop". */
export const inMarketplace = (provider: Provider) =>
  `${provider === 'mercadolivre' ? 'no' : 'na'} ${providerLabels[provider]}`;
const ofMarketplace = (provider: Provider) =>
  `${provider === 'mercadolivre' ? 'do' : 'da'} ${providerLabels[provider]}`;

const statusTones: Record<PublishStatus | 'none', StatusTone> = {
  none: 'idle',
  publishing: 'warn',
  active: 'ok',
  review: 'warn',
  paused: 'warn',
  closed: 'idle',
  error: 'error',
};

/** Rótulo e cor do estado do anúncio no marketplace. */
export function publishStatusInfo(
  provider: Provider,
  status: PublishStatus | null,
): { label: string; tone: StatusTone } {
  const s = status ?? 'none';
  const where = inMarketplace(provider);
  const labels: Record<PublishStatus | 'none', string> = {
    none: 'Ainda não publicado',
    publishing: 'Publicando…',
    active: `Ativo ${where}`,
    review: `Em análise ${where}`,
    paused: `Pausado ${where}`,
    closed: `Encerrado ${where}`,
    error: 'Não publicado (erro)',
  };
  return { label: labels[s], tone: statusTones[s] };
}

function publishMessages(provider: Provider): Record<string, string> {
  const name = providerLabels[provider];
  const of = ofMarketplace(provider);
  const account = provider === 'mercadolivre' ? 'sua conta do Mercado Livre' : `sua loja ${of}`;
  const messages: Record<string, string> = {
    'products.not_found': 'Produto não encontrado ou sem permissão.',
    'channels.sellers_only': 'Publicação é exclusiva de vendedores.',
    'channels.save_first': `Salve a configuração ${of} antes.`,
    'channels.disabled': 'Marque "Vender neste canal" e salve antes de publicar.',
    'channels.invalid': 'Dados inválidos. Revise os atributos.',
    'publish.category_required': `Escolha a categoria ${of} e salve antes de publicar.`,
    'publish.not_connected': `Conecte ${account} em Integrações antes de publicar.`,
    'publish.connection_inactive': `A conta ${of} deste anúncio está pausada ou desconectada. Reative em Integrações.`,
    'publish.not_published': 'O anúncio ainda não foi publicado.',
    'publish.busy': 'Já existe uma publicação em andamento. Aguarde alguns instantes.',
    'publish.no_active_variants': 'Ative ao menos uma variação do produto.',
    rate_limited: 'Muitas tentativas seguidas. Aguarde alguns minutos.',
    not_configured: `A integração com ${provider === 'mercadolivre' ? 'o' : 'a'} ${name} ainda não foi configurada pela equipe TheSigns.`,
    unauthorized: 'Sua sessão expirou. Entre de novo.',
    forbidden: 'Sem permissão para esta ação.',
  };
  // Mercado Livre responde com os mesmos erros prefixados (ml.*).
  for (const [k, v] of Object.entries(messages))
    if (k.startsWith('publish.')) messages[`ml.${k.slice(8)}`] = v;
  return messages;
}

export function publishErrorMessage(
  code: string | null,
  detail?: string | null,
  provider: Provider = 'mercadolivre',
): string {
  if (detail) return detail;
  return (
    (code && publishMessages(provider)[code]) ||
    `Não foi possível falar com ${provider === 'mercadolivre' ? 'o' : 'a'} ${providerLabels[provider]}. Tente de novo.`
  );
}

/** Compatibilidade: mensagens do Mercado Livre. */
export const mlPublishErrorMessage = (code: string | null, detail?: string | null) =>
  publishErrorMessage(code, detail, 'mercadolivre');
