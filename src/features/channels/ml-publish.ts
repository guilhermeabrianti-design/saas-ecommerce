import { z } from 'zod';
import type { StatusTone } from '@/components/ui/StatusDot';

/** Publicação no Mercado Livre (Fase 37): lógica da tela. */

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

export const publishStatuses = ['publishing', 'active', 'paused', 'closed', 'error'] as const;
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

export const publishStatusInfo: Record<
  PublishStatus | 'none',
  { label: string; tone: StatusTone }
> = {
  none: { label: 'Ainda não publicado', tone: 'idle' },
  publishing: { label: 'Publicando…', tone: 'warn' },
  active: { label: 'Ativo no Mercado Livre', tone: 'ok' },
  paused: { label: 'Pausado no Mercado Livre', tone: 'warn' },
  closed: { label: 'Encerrado no Mercado Livre', tone: 'idle' },
  error: { label: 'Não publicado (erro)', tone: 'error' },
};

const publishMessages: Record<string, string> = {
  'products.not_found': 'Produto não encontrado ou sem permissão.',
  'channels.sellers_only': 'Publicação é exclusiva de vendedores.',
  'channels.save_first': 'Salve a configuração do Mercado Livre antes.',
  'channels.disabled': 'Marque "Vender neste canal" e salve antes de publicar.',
  'channels.invalid': 'Dados inválidos. Revise os atributos.',
  'ml.category_required': 'Escolha a categoria do Mercado Livre e salve antes de publicar.',
  'ml.not_connected': 'Conecte sua conta do Mercado Livre em Integrações antes de publicar.',
  'ml.connection_inactive':
    'A conta do Mercado Livre deste anúncio está pausada ou desconectada. Reative em Integrações.',
  'ml.not_published': 'O anúncio ainda não foi publicado.',
  'ml.busy': 'Já existe uma publicação em andamento. Aguarde alguns instantes.',
  'ml.no_active_variants': 'Ative ao menos uma variação do produto.',
  rate_limited: 'Muitas tentativas seguidas. Aguarde alguns minutos.',
  not_configured:
    'A integração com o Mercado Livre ainda não foi configurada pela equipe TheSigns.',
  unauthorized: 'Sua sessão expirou. Entre de novo.',
  forbidden: 'Sem permissão para esta ação.',
};

export function mlPublishErrorMessage(code: string | null, detail?: string | null): string {
  if (detail) return detail;
  return (
    (code && publishMessages[code]) || 'Não foi possível falar com o Mercado Livre. Tente de novo.'
  );
}
