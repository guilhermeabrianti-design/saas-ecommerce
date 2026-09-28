import { z } from 'zod';
import { orgKinds } from '@/features/organizations/roles';

export const ratingSummarySchema = z.object({
  rating_avg: z.number().nullable(),
  rating_count: z.number().int(),
});

export type RatingSummary = z.infer<typeof ratingSummarySchema>;

export const reviewSchema = z.object({
  id: z.uuid(),
  source: z.enum(['buyer', 'seller']),
  reviewer_label: z.string(),
  product_name: z.string().nullable(),
  rating: z.number().int(),
  comment: z.string().nullable(),
  reply: z.string().nullable(),
  replied_at: z.string().nullable(),
  created_at: z.string(),
});

export type Review = z.infer<typeof reviewSchema>;

export const reputationSchema = ratingSummarySchema.extend({
  kind: z.enum(orgKinds),
  name: z.string(),
  can_reply: z.boolean(),
  distribution: z.record(z.string(), z.number().int()),
  metrics: z.record(z.string(), z.number().nullable()),
  reviews: z.array(reviewSchema),
});

export type Reputation = z.infer<typeof reputationSchema>;

/** Abaixo disso as taxas oscilam demais para dizer algo. */
export const MIN_ORDERS_FOR_RATES = 5;

export interface Rate {
  label: string;
  value: string;
  hint: string;
}

const pct = (part: number, total: number) =>
  `${Math.round((part / total) * 100).toLocaleString('pt-BR')}%`;

/** Métricas objetivas (90 dias) em texto; vazio quando há poucos pedidos. */
export function metricRates(r: Pick<Reputation, 'kind' | 'metrics'>): Rate[] {
  const m = r.metrics;
  const orders = m.orders ?? 0;
  if (orders < MIN_ORDERS_FOR_RATES) return [];
  if (r.kind === 'supplier') {
    const rates: Rate[] = [
      {
        label: 'Pedidos enviados',
        value: pct(m.shipped ?? 0, orders),
        hint: `${orders} pedidos em 90 dias`,
      },
      { label: 'Cancelamentos', value: pct(m.cancelled ?? 0, orders), hint: 'Pedidos cancelados' },
    ];
    if (m.avg_ship_hours != null) {
      const h = m.avg_ship_hours;
      rates.push({
        label: 'Tempo até o envio',
        value: h < 48 ? `${h} h` : `${Math.round(h / 24)} dias`,
        hint: 'Média entre o pedido e o envio',
      });
    }
    return rates;
  }
  return [
    {
      label: 'Entregues',
      value: pct(m.delivered ?? 0, orders),
      hint: `${orders} vendas pagas em 90 dias`,
    },
    { label: 'Enviados', value: pct(m.shipped ?? 0, orders), hint: 'Enviados ou entregues' },
    {
      label: 'Cancelamentos',
      value: pct(m.cancelled ?? 0, orders),
      hint: 'Vendas pagas canceladas',
    },
  ];
}

export const formatRating = (avg: number | null) =>
  avg == null
    ? '—'
    : avg.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const reviewCountLabel = (n: number) => (n === 1 ? '1 avaliação' : `${n} avaliações`);

export const reviewFormSchema = z.object({
  rating: z.number().int().min(1, 'Escolha de 1 a 5 estrelas').max(5),
  comment: z.string().trim().max(1000, 'Máximo de 1000 caracteres'),
});

export type ReviewFormValues = z.infer<typeof reviewFormSchema>;

export const adminReviewSchema = z.object({
  id: z.uuid(),
  target_name: z.string(),
  target_kind: z.enum(orgKinds),
  source: z.enum(['buyer', 'seller']),
  reviewer_label: z.string(),
  reviewer_org_name: z.string().nullable(),
  rating: z.number().int(),
  comment: z.string().nullable(),
  reply: z.string().nullable(),
  hidden_at: z.string().nullable(),
  hidden_reason: z.string().nullable(),
  created_at: z.string(),
});

export type AdminReview = z.infer<typeof adminReviewSchema>;

const messages: Record<string, string> = {
  'reviews.not_found': 'Avaliação ou pedido não encontrado.',
  'reviews.invalid': 'Escolha de 1 a 5 estrelas; comentário até 1000 caracteres.',
  'reviews.not_allowed': 'Só dá para avaliar depois que o pedido for enviado.',
  'reviews.already_reviewed': 'Este pedido já foi avaliado.',
  'reviews.already_replied': 'Esta avaliação já tem resposta.',
  'reviews.reason_required': 'Informe o motivo para ocultar (3 a 300 caracteres).',
  'admin.forbidden': 'Apenas a equipe da plataforma (com verificação em duas etapas).',
  review_not_allowed: 'Só dá para avaliar depois que o pedido for enviado.',
  already_reviewed: 'Este pedido já foi avaliado.',
  rate_limited: 'Muitas tentativas. Aguarde um pouco.',
};

export function reviewErrorMessage(error: unknown): string {
  const e = error as { message?: unknown; code?: unknown } | null;
  for (const key of [e?.message, e?.code]) {
    if (typeof key === 'string' && messages[key]) return messages[key];
  }
  return 'Não foi possível concluir. Tente de novo.';
}
