import { z } from 'zod';
import { orgErrorMessage } from '@/features/organizations/errors';
import { providers, type Provider } from '@/features/integrations/schemas';
import { parseBRL } from '@/utils/money';

/**
 * Taxas e comissões. Os valores vêm SEMPRE do banco (`marketplace_fee_rules`,
 * `commission_rules`) e a divisão é calculada lá; aqui só há conversão de
 * entrada e formatação.
 */

/** Percentual digitado ("15", "14,5", "2.99%") → pontos-base (1500, 1450, 299). */
export function parsePercentToBps(input: string): number | null {
  const text = input.trim().replace(/%$/, '').trim().replace(',', '.');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return null;
  const [int = '0', frac = ''] = text.split('.');
  const bps = Number(int) * 100 + Number(frac.padEnd(2, '0'));
  return bps <= 10000 ? bps : null;
}

/** 1450 → "14,5%"; 1500 → "15%". */
export function formatBps(bps: number): string {
  return `${(bps / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
}

/** Valor de campo para pontos-base: 1450 → "14,5". */
export function bpsToInput(bps: number | null | undefined): string {
  if (bps == null) return '';
  return (bps / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2, useGrouping: false });
}

// ---------------------------------------------------------------------
// Esquemas das respostas do banco
// ---------------------------------------------------------------------
const int = z.number().int();

export const categorySchema = z.object({
  id: z.uuid(),
  parent_id: z.uuid().nullable(),
  name: z.string(),
  is_active: z.boolean(),
});
export type Category = z.infer<typeof categorySchema>;

export const feeRuleSchema = z.object({
  id: z.uuid(),
  provider: z.enum(providers),
  listing_type: z.string(),
  label: z.string(),
  category_id: z.uuid().nullable(),
  campaign: z.string().nullable(),
  min_unit_price_cents: z.coerce.number().int(),
  max_unit_price_cents: z.coerce.number().int().nullable(),
  percent_bps: int,
  fixed_cents_per_item: z.coerce.number().int(),
  is_active: z.boolean(),
  notes: z.string().nullable(),
  updated_at: z.string(),
});
export type FeeRule = z.infer<typeof feeRuleSchema>;

export const commissionScopes = ['default', 'category', 'product', 'seller'] as const;
export type CommissionScope = (typeof commissionScopes)[number];

export const commissionScopeLabels: Record<CommissionScope, string> = {
  default: 'Padrão',
  category: 'Categoria',
  product: 'Produto',
  seller: 'Vendedor',
};

export const commissionRuleSchema = z.object({
  id: z.uuid(),
  scope: z.enum(commissionScopes),
  target_id: z.uuid().nullable(),
  target_name: z.string().nullable(),
  target_detail: z.string().nullable(),
  percent_bps: int,
  updated_at: z.string(),
});
export type CommissionRule = z.infer<typeof commissionRuleSchema>;

const ruleRef = z.object({
  id: z.uuid(),
  label: z.string(),
  percent_bps: int,
  fixed_cents_per_item: int,
});

export const splitSchema = z.object({
  unit_price_cents: int,
  quantity: int,
  sale_cents: int,
  marketplace_fee_cents: int,
  fee_rule: ruleRef,
  campaign_rule: ruleRef.extend({ campaign: z.string() }).nullable(),
  supplier_cents: int,
  seller_commission_bps: int,
  seller_commission_source: z.enum([...commissionScopes, 'parent_category']),
  seller_commission_cents: int,
  platform_cents: int,
  platform_margin_bps: int,
});
export type Split = z.infer<typeof splitSchema>;

export const commissionSourceLabels: Record<Split['seller_commission_source'], string> = {
  default: 'comissão padrão',
  category: 'regra da categoria',
  parent_category: 'regra da categoria-mãe',
  product: 'regra do produto',
  seller: 'acordo com o vendedor',
};

// ---------------------------------------------------------------------
// Opções para escolher marketplace / tipo de anúncio / campanha
// ---------------------------------------------------------------------
export interface FeeOptions {
  provider: Provider;
  types: { value: string; label: string; campaigns: string[] }[];
}

/** Marketplaces, tipos de anúncio e campanhas que têm regra ATIVA configurada. */
export function feeOptions(rules: FeeRule[]): FeeOptions[] {
  const result: FeeOptions[] = [];
  for (const provider of providers) {
    const active = rules.filter((r) => r.is_active && r.provider === provider);
    const types = [...new Set(active.filter((r) => !r.campaign).map((r) => r.listing_type))]
      .sort()
      .map((value) => ({
        value,
        label: active.find((r) => r.listing_type === value && !r.campaign)?.label ?? value,
        campaigns: [
          ...new Set(
            active.flatMap((r) => (r.listing_type === value && r.campaign ? [r.campaign] : [])),
          ),
        ].sort(),
      }));
    if (types.length) result.push({ provider, types });
  }
  return result;
}

/** Faixa de preço legível: "até R$ 49,99", "a partir de R$ 50,00", "qualquer preço". */
export function describeBand(min: number, max: number | null, format: (c: number) => string) {
  if (max === null) return min === 0 ? 'Qualquer preço' : `A partir de ${format(min)}`;
  if (min === 0) return `Abaixo de ${format(max)}`;
  return `De ${format(min)} até abaixo de ${format(max)}`;
}

// ---------------------------------------------------------------------
// Formulário de regra de taxa (equipe)
// ---------------------------------------------------------------------
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, {
    error: 'Use letras minúsculas, números, - ou _ (ex.: classico).',
  });

const money = (required: boolean) =>
  z
    .string()
    .trim()
    .refine((v) => (v === '' ? !required : parseBRL(v) !== null), {
      error: 'Valor inválido, ex.: 49,90',
    });

export const feeRuleFormSchema = z
  .object({
    provider: z.enum(providers),
    listingType: slug,
    label: z.string().trim().min(2, { error: 'Informe o nome exibido.' }).max(60),
    categoryId: z.string(),
    campaign: z.union([z.literal(''), slug]),
    minPrice: money(false),
    maxPrice: money(false),
    percent: z
      .string()
      .refine((v) => parsePercentToBps(v) !== null, { error: 'Percentual entre 0 e 100.' }),
    fixed: money(false),
    isActive: z.boolean(),
    notes: z.string().trim().max(500),
  })
  .refine((v) => v.maxPrice === '' || (parseBRL(v.maxPrice) ?? 0) > (parseBRL(v.minPrice) ?? 0), {
    error: 'O limite superior deve ser maior que o inferior.',
    path: ['maxPrice'],
  });

export type FeeRuleFormValues = z.infer<typeof feeRuleFormSchema>;

export function toFeeRuleFormValues(rule: FeeRule | null): FeeRuleFormValues {
  const cents = (c: number | null) =>
    c == null || c === 0 ? '' : (c / 100).toFixed(2).replace('.', ',');
  return {
    provider: rule?.provider ?? 'mercadolivre',
    listingType: rule?.listing_type ?? '',
    label: rule?.label ?? '',
    categoryId: rule?.category_id ?? '',
    campaign: rule?.campaign ?? '',
    minPrice: cents(rule?.min_unit_price_cents ?? null),
    maxPrice: cents(rule?.max_unit_price_cents ?? null),
    percent: bpsToInput(rule?.percent_bps),
    fixed: cents(rule?.fixed_cents_per_item ?? null),
    isActive: rule?.is_active ?? true,
    notes: rule?.notes ?? '',
  };
}

export function toFeeRulePayload(v: FeeRuleFormValues) {
  return {
    provider: v.provider,
    listing_type: v.listingType,
    label: v.label,
    category_id: v.categoryId || null,
    campaign: v.campaign || null,
    min_unit_price_cents: v.minPrice === '' ? 0 : parseBRL(v.minPrice),
    max_unit_price_cents: v.maxPrice === '' ? null : parseBRL(v.maxPrice),
    percent_bps: parsePercentToBps(v.percent),
    fixed_cents_per_item: v.fixed === '' ? 0 : parseBRL(v.fixed),
    is_active: v.isActive,
    notes: v.notes || null,
  };
}

// ---------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------
const messages: Partial<Record<string, string>> = {
  'fees.invalid': 'Dados inválidos. Revise os campos.',
  'fees.not_found': 'Item não encontrado. Atualize a página.',
  'fees.no_change': 'A regra já está neste estado. Atualize a página.',
  'fees.overlap':
    'Já existe uma regra ativa para o mesmo marketplace, tipo, categoria e campanha com faixa de preço sobreposta.',
  'fees.duplicate': 'Já existe uma categoria com esse nome neste nível.',
  'fees.invalid_parent':
    'Categorias têm só dois níveis: a categoria-mãe não pode ser uma subcategoria nem ter subcategorias movidas.',
  'fees.default_required': 'A comissão padrão não pode ser removida, apenas alterada.',
  'fees.category_inactive': 'Esta categoria está desativada. Escolha outra.',
  'fees.forbidden': 'Disponível apenas para membros de organizações vendedoras.',
  'fees.not_configured':
    'Taxa não configurada para este marketplace, tipo de anúncio e preço. Peça à equipe TheSigns para cadastrar.',
  'fees.campaign_not_configured': 'Campanha sem taxa configurada para este tipo e preço.',
  'fees.commission_not_configured': 'Comissão do vendedor não configurada.',
  'catalog.listing_not_found': 'Este produto não está mais disponível no catálogo.',
  'admin.forbidden': 'Acesso restrito à equipe da plataforma.',
};

export function feesErrorMessage(error: unknown): string {
  const { message } = (error ?? {}) as { message?: unknown };
  if (typeof message === 'string' && messages[message]) return messages[message];
  return orgErrorMessage(error);
}

export const feesAuditLabels: Record<string, string> = {
  'fees.rule_saved': 'Taxa de marketplace salva',
  'fees.rule_activated': 'Taxa de marketplace ativada',
  'fees.rule_deactivated': 'Taxa de marketplace desativada',
  'commission.saved': 'Comissão do vendedor alterada',
  'commission.deleted': 'Regra de comissão removida',
  'category.saved': 'Categoria salva',
  'category.activated': 'Categoria ativada',
  'category.deactivated': 'Categoria desativada',
};

/** Nome com a categoria-mãe: "Eletrônicos › Relógios". */
export function categoryPath(c: Category, all: Category[]): string {
  const parent = c.parent_id ? all.find((p) => p.id === c.parent_id) : undefined;
  return parent ? `${parent.name} › ${c.name}` : c.name;
}

/** Ordenadas como árvore (mãe seguida das filhas). */
export function sortCategories(all: Category[]): Category[] {
  const byName = (a: Category, b: Category) => a.name.localeCompare(b.name, 'pt-BR');
  return all
    .filter((c) => !c.parent_id)
    .sort(byName)
    .flatMap((p) => [p, ...all.filter((c) => c.parent_id === p.id).sort(byName)]);
}
