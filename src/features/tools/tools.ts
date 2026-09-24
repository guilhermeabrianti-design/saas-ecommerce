import { z } from 'zod';
import { feesErrorMessage } from '@/features/fees/fees';
import type { Provider } from '@/features/integrations/schemas';
import { parseBRL } from '@/utils/money';
import {
  GENERATION_KINDS,
  KIND_SPECS,
  type GenerationKind,
} from '../../../supabase/functions/_shared/ai/generation';

export { GENERATION_KINDS, KIND_SPECS, type GenerationKind };

export const generationLabels: Record<GenerationKind, { label: string; hint: string }> = {
  title: { label: 'Títulos de anúncio', hint: '5 opções de até 60 caracteres para marketplaces.' },
  ad_copy: { label: 'Copy para redes sociais', hint: '3 legendas com chamada e hashtags.' },
  video_script: { label: 'Roteiro de vídeo', hint: 'TikTok/Reels de 30 a 60 segundos.' },
  live_script: { label: 'Roteiro de live', hint: 'Apresentação do produto numa live de vendas.' },
};

export const MAX_BRIEF = 300;

// ---------------------------------------------------------------------
// Calculadoras
// ---------------------------------------------------------------------

/** "12,5" → 1250 pontos-base; vazio → 0; inválido → null. */
export function parsePercent(input: string, { min = 0, max = 100 } = {}): number | null {
  const v = input.trim().replace('%', '').replace(',', '.');
  if (v === '') return 0;
  if (!/^-?\d{1,3}(\.\d{1,2})?$/.test(v)) return null;
  const n = Number(v);
  if (n < min || n > max) return null;
  return Math.round(n * 100);
}

/** Dinheiro opcional: vazio → 0. */
function parseMoney(input: string): number | null {
  return input.trim() === '' ? 0 : parseBRL(input);
}

export interface CostInputs {
  cost: string;
  shipping: string;
  tax: string;
  anticipation: string;
}

export interface Channel {
  provider: Provider;
  listingType: string;
  categoryId: string | null;
}

export interface PricingCosts {
  costCents: number;
  shippingCents: number;
  taxBps: number;
  anticipationBps: number;
}

export type Parsed<T> =
  { ok: true; value: T } | { ok: false; errors: Partial<Record<string, string>> };

export function parseCosts(v: CostInputs): Parsed<PricingCosts> {
  const costCents = parseMoney(v.cost);
  const shippingCents = parseMoney(v.shipping);
  const taxBps = parsePercent(v.tax);
  const anticipationBps = parsePercent(v.anticipation);
  const errors: Partial<Record<keyof CostInputs, string>> = {};
  if (costCents === null) errors.cost = 'Valor inválido, ex.: 25,90';
  if (shippingCents === null) errors.shipping = 'Valor inválido, ex.: 12,00';
  if (taxBps === null) errors.tax = 'De 0 a 100, ex.: 6 ou 4,5';
  if (anticipationBps === null) errors.anticipation = 'De 0 a 100, ex.: 2,99';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      costCents: costCents!,
      shippingCents: shippingCents!,
      taxBps: taxBps!,
      anticipationBps: anticipationBps!,
    },
  };
}

/** Margem desejada: até 99% (100% exigiria preço infinito). */
export function parseMargin(input: string): number | null {
  if (input.trim() === '') return null;
  return parsePercent(input, { min: -100, max: 99 });
}

const int = z.number().int();

export const pricingSchema = z.object({
  price_cents: int,
  marketplace_fee_cents: int,
  fee_rule: z.object({
    id: z.uuid(),
    label: z.string(),
    percent_bps: int,
    fixed_cents_per_item: int,
  }),
  tax_cents: int,
  anticipation_cents: int,
  cost_cents: int,
  shipping_cents: int,
  profit_cents: int,
  margin_bps: int,
  target_margin_bps: int.optional(),
});
export type Pricing = z.infer<typeof pricingSchema>;

/** Linhas do detalhamento, na ordem em que saem do preço. */
export function pricingLines(p: Pricing) {
  return [
    { label: 'Preço de venda', cents: p.price_cents, sign: 1 as const },
    {
      label: `Taxa do marketplace (${p.fee_rule.label})`,
      cents: p.marketplace_fee_cents,
      sign: -1 as const,
    },
    { label: 'Impostos', cents: p.tax_cents, sign: -1 as const },
    { label: 'Antecipação', cents: p.anticipation_cents, sign: -1 as const },
    { label: 'Custo do produto', cents: p.cost_cents, sign: -1 as const },
    { label: 'Frete pago por você', cents: p.shipping_cents, sign: -1 as const },
  ].filter((l) => l.sign === 1 || l.cents !== 0);
}

const messages: Partial<Record<string, string>> = {
  'pricing.invalid': 'Confira os valores informados.',
  'pricing.unreachable':
    'Essa margem não é possível: taxas, impostos e antecipação somados à margem chegam a 100% do preço.',
  'pricing.forbidden': 'Entre novamente para usar a calculadora.',
};

export function toolsErrorMessage(error: unknown): string {
  const { message } = (error ?? {}) as { message?: unknown };
  if (typeof message === 'string' && messages[message]) return messages[message]!;
  return feesErrorMessage(error);
}

// ---------------------------------------------------------------------
// Preferências do navegador (conveniência; nada depende disso)
// ---------------------------------------------------------------------
const PREFS_KEY = 'thesigns.tools.costs';

export function loadCostPrefs(): Pick<CostInputs, 'tax' | 'anticipation'> {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;
    return {
      tax: typeof raw.tax === 'string' ? raw.tax : '',
      anticipation: typeof raw.anticipation === 'string' ? raw.anticipation : '',
    };
  } catch {
    return { tax: '', anticipation: '' };
  }
}

export function saveCostPrefs(v: Pick<CostInputs, 'tax' | 'anticipation'>) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ tax: v.tax, anticipation: v.anticipation }));
  } catch {
    // Armazenamento indisponível (aba anônima, bloqueio): segue sem lembrar.
  }
}
