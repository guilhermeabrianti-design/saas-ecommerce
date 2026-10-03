import { z } from 'zod';
import { orgKinds, type OrgKind } from '@/features/organizations/roles';
import { centsToInput, formatBRL, parseBRL } from '@/utils/money';
import type { PlanInput } from './api';

/** Planos e assinaturas (Fase 42). */

export const subscriptionStatuses = ['pending', 'authorized', 'paused', 'cancelled'] as const;
export type SubscriptionStatus = (typeof subscriptionStatuses)[number];

export const subscriptionStatusLabels: Record<SubscriptionStatus, string> = {
  pending: 'Aguardando pagamento',
  authorized: 'Ativa',
  paused: 'Pausada',
  cancelled: 'Cancelada',
};

const planSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  price_cents: z.number().int(),
  ai_daily_limit: z.number().int().nullable(),
  max_products: z.number().int().nullable(),
  featured_slots: z.number().int(),
  is_default: z.boolean(),
});
export type Plan = z.infer<typeof planSchema>;

export const overviewSchema = z.object({
  plan: planSchema,
  usage: z.object({
    products: z.number().int(),
    ai_today: z.number().int(),
    ai_daily_limit: z.number().int(),
    featured: z.number().int(),
  }),
  can_manage: z.boolean(),
  current: z
    .object({
      id: z.uuid(),
      plan_name: z.string(),
      status: z.enum(subscriptionStatuses),
      price_cents: z.number().int(),
      next_payment_at: z.string().nullable(),
      access_until: z.string().nullable(),
      authorized_at: z.string().nullable(),
    })
    .nullable(),
  pending: z
    .object({
      id: z.uuid(),
      plan_id: z.uuid(),
      plan_name: z.string(),
      price_cents: z.number().int(),
      checkout_url: z.string().nullable(),
      created_at: z.string(),
    })
    .nullable(),
  plans: z.array(planSchema),
  payments: z.array(
    z.object({
      external_id: z.string(),
      amount_cents: z.number().int(),
      status: z.string(),
      payment_status: z.string().nullable(),
      debit_date: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
});
export type BillingOverview = z.infer<typeof overviewSchema>;

export const featuredStatusSchema = z.object({
  marked: z.boolean(),
  active: z.boolean(),
  used: z.number().int(),
  slots: z.number().int(),
});
export type FeaturedStatus = z.infer<typeof featuredStatusSchema>;

export const adminOverviewSchema = z.object({
  plans: z.array(
    planSchema.extend({
      org_kind: z.enum(orgKinds),
      active: z.boolean(),
      position: z.number().int(),
      subscribers: z.number().int(),
    }),
  ),
  monthly_revenue_cents: z.coerce.number().int(),
  subscriptions: z.array(
    z.object({
      id: z.uuid(),
      organization_name: z.string(),
      org_kind: z.enum(orgKinds),
      plan_name: z.string(),
      status: z.enum(subscriptionStatuses),
      price_cents: z.number().int(),
      next_payment_at: z.string().nullable(),
      access_until: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
});
export type AdminBillingOverview = z.infer<typeof adminOverviewSchema>;
export type AdminPlan = AdminBillingOverview['plans'][number];

export const formatPlanPrice = (cents: number) =>
  cents === 0 ? 'Grátis' : `${formatBRL(cents)}/mês`;

/** O que o plano inclui, em frases curtas. */
export function planFeatures(
  plan: Pick<Plan, 'ai_daily_limit' | 'max_products' | 'featured_slots'>,
  kind: 'seller' | 'supplier',
): string[] {
  const out: string[] = [];
  out.push(
    plan.max_products === null
      ? 'Produtos sem limite'
      : `Até ${plan.max_products.toLocaleString('pt-BR')} produtos`,
  );
  out.push(
    plan.ai_daily_limit === null
      ? 'Gerações de IA no limite padrão'
      : `${plan.ai_daily_limit.toLocaleString('pt-BR')} gerações de IA por dia`,
  );
  if (kind === 'supplier') {
    out.push(
      plan.featured_slots === 0
        ? 'Sem destaque no catálogo'
        : `${plan.featured_slots} ${plan.featured_slots === 1 ? 'produto' : 'produtos'} em destaque no catálogo`,
    );
  }
  return out;
}

/** Texto da situação da assinatura vigente. */
export function subscriptionNote(
  current: NonNullable<BillingOverview['current']>,
  now = Date.now(),
): string {
  const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');
  if (current.status === 'authorized') {
    return current.next_payment_at
      ? `Próxima cobrança em ${day(current.next_payment_at)}.`
      : 'Cobrança mensal no cartão.';
  }
  if (current.access_until && new Date(current.access_until).getTime() > now) {
    return `${subscriptionStatusLabels[current.status]}: o plano vale até ${day(current.access_until)}.`;
  }
  return subscriptionStatusLabels[current.status];
}

export const paymentStatusLabels: Record<string, string> = {
  approved: 'Paga',
  rejected: 'Recusada',
  pending: 'Pendente',
  in_process: 'Em análise',
  refunded: 'Estornada',
  cancelled: 'Cancelada',
};

export const plansAuditLabels: Record<string, string> = {
  'plans.saved': 'Plano salvo',
};

const messages: Record<string, string> = {
  'org.forbidden': 'Sem permissão para esta ação.',
  forbidden: 'Só o proprietário da empresa gerencia o plano.',
  'plans.invalid': 'Dados inválidos. Revise os campos.',
  invalid_body: 'Dados inválidos. Revise os campos.',
  'plans.not_found': 'Plano não encontrado.',
  'plans.unavailable': 'Este plano não está disponível para a sua empresa.',
  unavailable: 'Este plano não está disponível para a sua empresa.',
  'plans.already_subscribed': 'A empresa já assina este plano.',
  already_subscribed: 'A empresa já assina este plano.',
  'plans.no_subscription': 'Não há assinatura ativa para cancelar.',
  no_subscription: 'Não há assinatura ativa para cancelar.',
  'plans.featured_limit': 'Todas as vagas de destaque do seu plano estão em uso.',
  'plans.product_limit': 'O plano da empresa chegou ao limite de produtos.',
  not_configured: 'Pagamentos ainda não configurados pela equipe TheSigns.',
  subscription_refused: 'O Mercado Pago recusou a assinatura. Confira o e-mail da conta.',
  cancel_refused: 'O Mercado Pago recusou o cancelamento. Tente de novo ou fale com o suporte.',
  provider_unavailable: 'O Mercado Pago não respondeu. Tente de novo em instantes.',
  'admin.forbidden': 'Apenas a equipe da plataforma (com verificação em duas etapas).',
};

export function plansErrorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && messages[message]) return messages[message];
  return 'Não foi possível concluir. Tente de novo.';
}

// ---------------------------------------------------------------------
// Formulário da equipe
// ---------------------------------------------------------------------

export interface PlanDraft {
  org_kind: OrgKind;
  name: string;
  description: string;
  price: string;
  ai: string;
  maxProducts: string;
  featured: string;
  active: boolean;
  position: string;
}

export const toPlanDraft = (p: AdminPlan | null, kind: OrgKind = 'seller'): PlanDraft => ({
  org_kind: p?.org_kind ?? kind,
  name: p?.name ?? '',
  description: p?.description ?? '',
  price: p ? centsToInput(p.price_cents) : '',
  ai: p?.ai_daily_limit == null ? '' : String(p.ai_daily_limit),
  maxProducts: p?.max_products == null ? '' : String(p.max_products),
  featured: String(p?.featured_slots ?? 0),
  active: p?.active ?? true,
  position: String(p?.position ?? 1),
});

const optionalInt = (v: string) =>
  v.trim() === '' ? null : /^\d{1,7}$/.test(v.trim()) ? Number(v.trim()) : NaN;

/** Rascunho → envio; nulo quando algum campo é inválido. O banco confere de novo. */
export function planDraftToInput(
  d: PlanDraft,
  id: string | null,
  isDefault: boolean,
): PlanInput | null {
  const price = isDefault ? 0 : parseBRL(d.price);
  const ai = optionalInt(d.ai);
  const max = optionalInt(d.maxProducts);
  const featured = optionalInt(d.featured);
  const position = optionalInt(d.position);
  const name = d.name.trim();
  if (
    name.length < 2 ||
    name.length > 60 ||
    d.description.length > 300 ||
    price === null ||
    (!isDefault && price < 100) ||
    Number.isNaN(ai) ||
    (ai !== null && ai > 10000) ||
    Number.isNaN(max) ||
    max === 0 ||
    featured === null ||
    Number.isNaN(featured) ||
    featured > 1000 ||
    Number.isNaN(position)
  ) {
    return null;
  }
  return {
    id,
    org_kind: d.org_kind,
    name,
    description: d.description.trim() || null,
    price_cents: price,
    ai_daily_limit: ai,
    max_products: max,
    featured_slots: featured,
    active: isDefault ? true : d.active,
    position: position ?? 0,
  };
}
