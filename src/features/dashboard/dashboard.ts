import { providerLabels, providers } from '@/features/integrations/schemas';
import { formatBRL } from '@/utils/money';
import type { SellerDashboard as Summary } from './api';

/** Passos devolvidos por `public.seller_onboarding` (a ordem vem do banco). */
export const onboardingStepKeys = [
  'profile',
  'products',
  'active_product',
  'channel',
  'first_order',
  'academy',
] as const;
export type OnboardingStepKey = (typeof onboardingStepKeys)[number];

export const onboardingSteps: Record<
  OnboardingStepKey,
  { label: string; detail: string; to: string; action: string }
> = {
  profile: {
    label: 'Complete seu cadastro',
    detail: 'Telefone e CPF ou CNPJ.',
    to: '/conta',
    action: 'Completar',
  },
  products: {
    label: 'Escolha produtos para vender',
    detail: 'Importe do catálogo de fornecedores ou cadastre os seus.',
    to: '/catalogo',
    action: 'Ver catálogo',
  },
  active_product: {
    label: 'Ative um produto',
    detail: 'Produtos em rascunho não entram em pedidos.',
    to: '/produtos',
    action: 'Ver produtos',
  },
  channel: {
    label: 'Conecte um canal de venda',
    detail: 'Receba os pedidos da sua loja automaticamente.',
    to: '/integracoes',
    action: 'Conectar',
  },
  first_order: {
    label: 'Registre sua primeira venda',
    detail: 'Manualmente ou recebida de um canal conectado.',
    to: '/pedidos/novo',
    action: 'Novo pedido',
  },
  academy: {
    label: 'Conclua uma aula da Academia',
    detail: 'Aprenda o passo a passo para vender.',
    to: '/academia',
    action: 'Abrir Academia',
  },
};

export interface OnboardingStep {
  key: OnboardingStepKey;
  done: boolean;
}

export function onboardingProgress(steps: OnboardingStep[]) {
  const done = steps.filter((s) => s.done).length;
  return {
    done,
    total: steps.length,
    percent: steps.length === 0 ? 100 : Math.round((done / steps.length) * 100),
    complete: done === steps.length,
    /** Primeiro passo pendente, na ordem sugerida. */
    next: steps.find((s) => !s.done)?.key ?? null,
  };
}

export const buckets = ['day', 'week', 'month'] as const;
export type Bucket = (typeof buckets)[number];

export const bucketLabels: Record<Bucket, string> = {
  day: 'Por dia',
  week: 'Por semana',
  month: 'Por mês',
};

/** Janela buscada para cada agrupamento (dias, incluindo hoje). */
export const bucketDays: Record<Bucket, number> = { day: 30, week: 84, month: 365 };

export const channels = ['manual', ...providers] as const;
export type Channel = (typeof channels)[number];

export const channelLabels: Record<Channel, string> = {
  manual: 'Pedido manual',
  ...providerLabels,
};

export function channelLabel(channel: string): string {
  return channel in channelLabels ? channelLabels[channel as Channel] : channel;
}

/** Rótulo curto do início do balde ("2026-09-22"), sem passar por Date. */
export function periodLabel(iso: string, bucket: Bucket): string {
  const [y, m, d] = iso.split('-');
  if (bucket === 'month') return `${m}/${y}`;
  return `${d}/${m}`;
}

/** Fatias (0–100) de cada canal no total; soma exatamente 100 quando há vendas. */
export function shares(values: number[]): number[] {
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  if (total === 0) return values.map(() => 0);
  const raw = values.map((v) => (Math.max(0, v) / total) * 100);
  const floored = raw.map(Math.floor);
  let rest = 100 - floored.reduce((s, v) => s + v, 0);
  // Distribui o que sobrou do arredondamento pelos maiores restos.
  const order = raw.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (rest <= 0) break;
    floored[i]! += 1;
    rest -= 1;
  }
  return floored;
}

export const int = (v: number) => v.toLocaleString('pt-BR');
export const percent = (bps: number) =>
  `${(bps / 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

export interface SummaryCard {
  label: string;
  value: string;
  hint: string;
  to?: string;
  tone?: 'bad';
}

export function summaryCards(s: Summary): SummaryCard[] {
  return [
    {
      label: 'Quanto vendi',
      value: formatBRL(s.sold_cents),
      hint: `${int(s.orders)} pedido(s), sem cancelados`,
      to: '/pedidos',
    },
    {
      label: 'Quanto ganhei (lucro bruto)',
      value: formatBRL(s.gross_profit_cents),
      hint:
        s.units_without_cost > 0
          ? `${int(s.units_without_cost)} un. sem custo cadastrado (contam como zero)`
          : 'Produtos − custo; taxas de marketplace não descontadas',
      tone: s.gross_profit_cents < 0 ? 'bad' : undefined,
    },
    {
      label: 'Recebido',
      value: formatBRL(s.received_cents),
      hint: 'Recebimentos registrados − estornos',
      to: '/carteira',
    },
    {
      label: 'Tenho a receber',
      value: formatBRL(s.receivable_cents),
      hint: `${int(s.receivable_orders)} pedido(s) sem pagamento completo · hoje`,
      to: '/pedidos',
    },
    {
      label: 'A pagar a fornecedores',
      value: formatBRL(s.payable_cents),
      hint: `${int(s.payable_orders)} fornecimento(s) enviado(s) e não pago(s) · hoje`,
      to: '/pedidos',
    },
  ];
}
