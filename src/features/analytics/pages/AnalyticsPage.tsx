import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { useOrganization } from '@/features/organizations/organization-context';
import { orgPermissions } from '@/features/organizations/roles';
import { cn } from '@/utils/cn';
import { formatBRL } from '@/utils/money';
import {
  analyticsErrorMessage,
  barHeights,
  periodOptions,
  shortDay,
  useDaily,
  useOverview,
  useTopItems,
  type Overview,
} from '../api';

interface Card {
  label: string;
  value: string;
  hint?: string;
  tone?: 'bad';
}

const int = (v: number) => v.toLocaleString('pt-BR');

function cardsFor(o: Overview): Card[] {
  if (o.kind === 'supplier') {
    return [
      {
        label: 'Pedidos de fornecimento',
        value: int(o.orders),
        hint: `${int(o.cancelled)} cancelados`,
      },
      { label: 'Faturamento (atacado)', value: formatBRL(o.wholesale_cents) },
      { label: 'Ticket médio', value: formatBRL(o.avg_ticket_cents) },
      { label: 'Unidades', value: int(o.units) },
      { label: 'Aguardando envio', value: int(o.awaiting_shipment), hint: 'Situação atual' },
      { label: 'A receber', value: formatBRL(o.unpaid_cents), hint: 'Enviados e não pagos' },
    ];
  }
  return [
    { label: 'Pedidos', value: int(o.orders), hint: `${int(o.cancelled)} cancelados` },
    { label: 'Receita', value: formatBRL(o.revenue_cents), hint: 'Total dos pedidos, com frete' },
    { label: 'Ticket médio', value: formatBRL(o.avg_ticket_cents) },
    { label: 'Unidades vendidas', value: int(o.units) },
    {
      label: 'Lucro bruto',
      value: formatBRL(o.gross_profit_cents),
      hint:
        o.units_without_cost > 0
          ? `${int(o.units_without_cost)} un. sem custo cadastrado (contam como custo zero)`
          : 'Produtos − custo (custo atual do cadastro; atacado nos itens de fornecedor)',
      tone: o.gross_profit_cents < 0 ? 'bad' : undefined,
    },
    {
      label: 'Via marketplace',
      value: int(o.marketplace_orders),
      hint: `de ${int(o.orders)} pedidos`,
    },
  ];
}

function Bars({ orgId, days, label }: { orgId: string; days: number; label: string }) {
  const daily = useDaily(orgId, days);
  if (daily.isPending) return <PageLoader />;
  if (daily.isError) return <Alert tone="error">{analyticsErrorMessage(daily.error)}</Alert>;

  const points = daily.data;
  const heights = barHeights(points.map((p) => p.amount_cents));
  const total = points.reduce((s, p) => s + p.amount_cents, 0);
  if (total === 0) return <p className="text-muted text-sm">Sem movimento no período.</p>;

  return (
    <figure className="space-y-2">
      <div
        role="img"
        aria-label={`${label} por dia: total ${formatBRL(total)} em ${days} dias`}
        className="flex h-40 items-end gap-px"
      >
        {points.map((p, i) => (
          <div
            key={p.day}
            title={`${shortDay(p.day)} · ${formatBRL(p.amount_cents)} · ${p.orders} pedido(s)`}
            className="flex h-full flex-1 items-end"
          >
            <div
              className="bg-brand w-full rounded-t-sm"
              style={{ height: `${heights[i]}%`, minWidth: 1 }}
            />
          </div>
        ))}
      </div>
      <figcaption className="text-muted flex justify-between text-xs">
        <span>{shortDay(points[0]!.day)}</span>
        <span>{label} por dia</span>
        <span>{shortDay(points[points.length - 1]!.day)}</span>
      </figcaption>
    </figure>
  );
}

function TopItems({ orgId, days }: { orgId: string; days: number }) {
  const top = useTopItems(orgId, days);
  if (top.isPending) return <PageLoader />;
  if (top.isError) return <Alert tone="error">{analyticsErrorMessage(top.error)}</Alert>;
  if (top.data.length === 0) return <p className="text-muted text-sm">Nada vendido no período.</p>;
  return (
    <ol className="divide-border -my-3 divide-y text-sm">
      {top.data.map((t, i) => (
        <li key={t.sku} className="flex items-center gap-3 py-3">
          <span className="text-muted w-5 text-right tabular-nums">{i + 1}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{t.name}</p>
            <p className="text-muted truncate font-mono text-xs">{t.sku}</p>
          </div>
          <span className="tabular-nums">{int(t.units)} un.</span>
          <span className="text-muted w-24 text-right tabular-nums">
            {formatBRL(t.amount_cents)}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function AnalyticsPage() {
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const [days, setDays] = useState(30);
  const overview = useOverview(orgId, days);
  const kind = active!.organization.kind;

  if (!orgPermissions.viewAnalytics(active!.role)) {
    return (
      <div className="mx-auto max-w-3xl">
        <Alert tone="info">
          As análises são visíveis apenas para proprietários e administradores.
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Análises</h1>
          <p className="text-muted text-sm">
            {kind === 'seller' ? 'Vendas' : 'Fornecimentos'} do período, sem pedidos cancelados.
          </p>
        </div>
        <div className="w-48">
          <Select
            aria-label="Período"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {periodOptions.map((p) => (
              <option key={p.days} value={p.days}>
                {p.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {overview.isPending ? (
        <PageLoader />
      ) : overview.isError ? (
        <Alert tone="error">{analyticsErrorMessage(overview.error)}</Alert>
      ) : (
        <>
          {overview.data.low_stock_items > 0 && (
            <Alert tone="info">
              {int(overview.data.low_stock_items)} item(ns) com estoque no mínimo ou abaixo.
            </Alert>
          )}
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cardsFor(overview.data).map((c) => (
              <div key={c.label} className="border-border bg-surface rounded-xl border px-4 py-3">
                <dt className="text-muted text-xs">{c.label}</dt>
                <dd
                  className={cn(
                    'text-2xl font-semibold tabular-nums',
                    c.tone === 'bad' && 'text-danger',
                  )}
                >
                  {c.value}
                </dd>
                {c.hint && <p className="text-muted mt-1 text-xs">{c.hint}</p>}
              </div>
            ))}
          </dl>
        </>
      )}

      <Section
        title={kind === 'seller' ? 'Receita por dia' : 'Faturamento por dia'}
        description="Passe o mouse sobre uma barra para ver o dia."
      >
        <Bars orgId={orgId} days={days} label={kind === 'seller' ? 'Receita' : 'Faturamento'} />
      </Section>

      <Section title="Mais vendidos" description="Por unidades no período.">
        <TopItems orgId={orgId} days={days} />
      </Section>
    </div>
  );
}
