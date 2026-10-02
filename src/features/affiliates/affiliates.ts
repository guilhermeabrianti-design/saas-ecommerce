import { z } from 'zod';
import { orgKinds } from '@/features/organizations/roles';
import { parseBRL } from '@/utils/money';

// ---------------------------------------------------------------------
// Códigos e endereços
// ---------------------------------------------------------------------

/** Mesma regra do banco: 4–32 caracteres, minúsculas, dígitos e hífen no meio. */
export const PUBLIC_CODE = /^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$/;

export const normalizeCode = (value: string) => value.trim().toLowerCase();

export const isValidCode = (value: string) => {
  const code = normalizeCode(value);
  return PUBLIC_CODE.test(code) && !code.includes('--');
};

const codeMessage = 'De 4 a 32 caracteres: letras minúsculas, números e hífen (não no início/fim)';

export const publicCodeSchema = z.string().refine(isValidCode, codeMessage);

export const referralUrl = (origin: string, code: string) =>
  `${origin}/cadastro?indicacao=${encodeURIComponent(code)}`;

// ---------------------------------------------------------------------
// Navegador do comprador: visitante, origem e código de indicação
// ---------------------------------------------------------------------

const VISITOR_KEY = 'thesigns:visitor';
const ATTRIBUTION_KEY = 'thesigns:attribution';
const REFERRAL_KEY = 'thesigns:referral';
const DAY = 24 * 60 * 60 * 1000;

/** Janela da atribuição: a venda conta para o último link acessado nos últimos 30 dias. */
export const ATTRIBUTION_DAYS = 30;
const REFERRAL_DAYS = 60;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Armazenamento bloqueado: segue sem atribuição.
  }
}

/** Id aleatório deste navegador (conta visitas únicas; o servidor guarda só o hash). */
export function visitorId(): string {
  const current = read(VISITOR_KEY);
  if (current && z.uuid().safeParse(current).success) return current;
  const id = crypto.randomUUID();
  write(VISITOR_KEY, id);
  return id;
}

export interface Attribution {
  store_code: string | null;
  link_code: string | null;
}

const storedAttributionSchema = z.object({
  store_code: z.string().nullable(),
  link_code: z.string().nullable(),
  at: z.number(),
});

/** Guarda a origem do acesso (último acesso vale). */
export function rememberAttribution(attribution: Attribution, now = Date.now()) {
  write(ATTRIBUTION_KEY, JSON.stringify({ ...attribution, at: now }));
}

/** Origem ainda dentro da janela, ou nula. */
export function currentAttribution(now = Date.now()): Attribution | null {
  const raw = read(ATTRIBUTION_KEY);
  if (!raw) return null;
  try {
    const parsed = storedAttributionSchema.parse(JSON.parse(raw));
    if (now - parsed.at > ATTRIBUTION_DAYS * DAY) {
      write(ATTRIBUTION_KEY, null);
      return null;
    }
    return { store_code: parsed.store_code, link_code: parsed.link_code };
  } catch {
    write(ATTRIBUTION_KEY, null);
    return null;
  }
}

/** Código de quem indicou, vindo de /cadastro?indicacao=… */
export function rememberReferralCode(code: string, now = Date.now()) {
  if (isValidCode(code))
    write(REFERRAL_KEY, JSON.stringify({ code: normalizeCode(code), at: now }));
}

export function pendingReferralCode(now = Date.now()): string | null {
  const raw = read(REFERRAL_KEY);
  if (!raw) return null;
  try {
    const parsed = z.object({ code: z.string(), at: z.number() }).parse(JSON.parse(raw));
    return now - parsed.at > REFERRAL_DAYS * DAY || !isValidCode(parsed.code) ? null : parsed.code;
  } catch {
    return null;
  }
}

export const clearReferralCode = () => write(REFERRAL_KEY, null);

// ---------------------------------------------------------------------
// Público: vitrine e link
// ---------------------------------------------------------------------

export const storeSchema = z.object({
  store: z.object({
    store_name: z.string(),
    store_code: z.string(),
    rating: z
      .object({ rating_avg: z.number().nullable(), rating_count: z.number().int() })
      .nullable()
      .optional(),
    products: z.array(
      z.object({
        product_id: z.uuid(),
        name: z.string(),
        price_cents: z.number().int(),
        has_variants: z.boolean(),
        image: z.string().nullable(),
      }),
    ),
  }),
});

export type PublicStore = z.infer<typeof storeSchema>['store'];

export const linkTargetSchema = z.object({
  link: z.object({
    link_code: z.string(),
    store_code: z.string(),
    product_id: z.uuid().nullable(),
  }),
});

export type LinkTarget = z.infer<typeof linkTargetSchema>['link'];

/** Para onde o link leva: produto no checkout ou vitrine. */
export const targetPath = (t: LinkTarget) =>
  t.product_id ? `/c/${t.product_id}` : `/loja/${t.store_code}`;

// ---------------------------------------------------------------------
// Vendedor: links e desempenho
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// Indicação
// ---------------------------------------------------------------------

export const referralStatuses = ['waiting', 'rewarded', 'expired'] as const;
export type ReferralStatus = (typeof referralStatuses)[number];

export const referralStatusLabels: Record<ReferralStatus, string> = {
  waiting: 'Aguardando a primeira venda',
  rewarded: 'Recompensa creditada',
  expired: 'Prazo encerrado',
};

export const programSchema = z.object({
  enabled: z.boolean(),
  reward_cents: z.number().int(),
  min_sale_cents: z.number().int(),
  window_days: z.number().int(),
});

export type ReferralProgram = z.infer<typeof programSchema>;

export const referralSummarySchema = z.object({
  code: z.string(),
  program: programSchema,
  referred_by: z
    .object({
      name: z.string(),
      created_at: z.string(),
      expires_at: z.string(),
      rewarded_at: z.string().nullable(),
    })
    .nullable(),
  can_apply: z.boolean(),
  earned_cents: z.number().int(),
  referrals: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(orgKinds),
      created_at: z.string(),
      expires_at: z.string(),
      reward_cents: z.number().int(),
      min_sale_cents: z.number().int(),
      rewarded_at: z.string().nullable(),
      status: z.enum(referralStatuses),
    }),
  ),
});

export type ReferralSummary = z.infer<typeof referralSummarySchema>;

export const adminReferralSchema = z.object({
  referred_org_id: z.uuid(),
  referred_name: z.string(),
  referred_kind: z.enum(orgKinds),
  referrer_org_id: z.uuid(),
  referrer_name: z.string(),
  reward_cents: z.number().int(),
  min_sale_cents: z.number().int(),
  status: z.enum(referralStatuses),
  created_at: z.string(),
  expires_at: z.string(),
  rewarded_at: z.string().nullable(),
  reward_order_number: z.number().int().nullable(),
});

export type AdminReferral = z.infer<typeof adminReferralSchema>;

export const referralOverviewSchema = z.object({
  total: z.number().int(),
  waiting: z.number().int(),
  rewarded: z.number().int(),
  rewarded_cents: z.number().int(),
});

export interface ReferralSettingsInput {
  enabled: boolean;
  reward: string;
  min_sale: string;
  window_days: string;
}

export interface ReferralSettings {
  enabled: boolean;
  reward_cents: number;
  min_sale_cents: number;
  window_days: number;
}

/** Valida o formulário da equipe; devolve os valores prontos ou o erro de cada campo. */
export function validateReferralSettings(input: ReferralSettingsInput): {
  values: ReferralSettings | null;
  errors: Partial<Record<keyof ReferralSettingsInput, string>>;
} {
  const errors: Partial<Record<keyof ReferralSettingsInput, string>> = {};
  const reward = parseBRL(input.reward);
  const minSale = parseBRL(input.min_sale);
  const days = Number(input.window_days);
  if (reward == null || reward < 0 || reward > 100_000_00) {
    errors.reward = 'Valor em reais, até R$ 100.000,00';
  } else if (input.enabled && reward < 1) {
    errors.reward = 'Para ligar o programa, defina uma recompensa maior que zero';
  }
  if (minSale == null || minSale < 0 || minSale > 1_000_000_00) {
    errors.min_sale = 'Valor em reais (0 = qualquer venda)';
  }
  if (!Number.isInteger(days) || days < 1 || days > 365) errors.window_days = 'De 1 a 365 dias';
  if (Object.keys(errors).length) return { values: null, errors };
  return {
    values: {
      enabled: input.enabled,
      reward_cents: reward!,
      min_sale_cents: minSale!,
      window_days: days,
    },
    errors,
  };
}

export const referralAuditLabels: Record<string, string> = {
  'referral.settings': 'Regras de indicação alteradas',
};

/** Resumo da regra, em uma frase. */
export function describeProgram(p: ReferralProgram, formatBRL: (c: number) => string): string {
  const min = p.min_sale_cents > 0 ? ` de pelo menos ${formatBRL(p.min_sale_cents)}` : '';
  return `Você ganha ${formatBRL(p.reward_cents)} quando a empresa indicada fizer a primeira venda paga pelo checkout${min} em até ${p.window_days} dias.`;
}

// ---------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------

const messages: Record<string, string> = {
  'affiliates.invalid_code': codeMessage + '.',
  'affiliates.code_taken': 'Esse código já está em uso. Escolha outro.',
  'affiliates.invalid_name': 'Dê um nome de 2 a 80 caracteres.',
  'affiliates.invalid_product': 'Produto não encontrado nesta loja.',
  'affiliates.limit_reached': 'Limite de 200 links por loja. Pause e reaproveite links antigos.',
  'affiliates.forbidden': 'Você não tem permissão para esta ação.',
  'affiliates.not_found': 'Link não encontrado ou sem permissão.',
  'referral.disabled': 'O programa de indicação está pausado.',
  'referral.invalid_code': 'Código de indicação não encontrado.',
  'referral.self': 'Não vale indicar a si mesmo ou uma empresa da mesma equipe.',
  'referral.already_referred': 'Esta empresa já informou quem a indicou.',
  'referral.too_late':
    'O código só pode ser informado nos primeiros 30 dias e antes da primeira venda.',
  'referral.forbidden': 'Só o proprietário informa o código de indicação.',
  'referral.invalid_settings': 'Revise as regras: recompensa maior que zero para ligar.',
  'admin.forbidden': 'Apenas a equipe da plataforma (com verificação em duas etapas).',
  rate_limited: 'Muitas operações seguidas. Aguarde um pouco e tente de novo.',
};

export function affiliateErrorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && messages[message]) return messages[message];
  return 'Não foi possível concluir. Tente de novo.';
}
