import { useState } from 'react';
import { Link } from 'react-router';
import { ImageOff } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { periodOptions } from '@/features/analytics/api';
import { orgPermissions, type OrgRole } from '@/features/organizations/roles';
import { cn } from '@/utils/cn';
import { formatBRL } from '@/utils/money';
import { dashboardErrorMessage, useChannels, useSellerDashboard, useSuggestions } from '../api';
import { channelLabel, int, percent, shares, summaryCards } from '../dashboard';
import { SalesChart } from './SalesChart';

function SummaryCards({ orgId, days }: { orgId: string; days: number }) {
  const summary = useSellerDashboard(orgId, days);
  if (summary.isPending) return <PageLoader />;
  if (summary.isError) return <Alert tone="error">{dashboardErrorMessage(summary.error)}</Alert>;

  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {summaryCards(summary.data).map((c) => {
        const body = (
          <>
            <dt className="text-muted text-xs">{c.label}</dt>
            <dd
              className={cn(
                'text-2xl font-semibold tabular-nums',
                c.tone === 'bad' && 'text-danger',
              )}
            >
              {c.value}
            </dd>
            <p className="text-muted mt-1 text-xs">{c.hint}</p>
          </>
        );
        const box = 'border-border bg-surface block rounded-xl border px-4 py-3';
        return (
          <div key={c.label}>
            {c.to ? (
              <Link to={c.to} className={cn(box, 'hover:border-brand/50 transition-colors')}>
                {body}
              </Link>
            ) : (
              <div className={box}>{body}</div>
            )}
          </div>
        );
      })}
    </dl>
  );
}

function Channels({ orgId, days }: { orgId: string; days: number }) {
  const channels = useChannels(orgId, days);
  if (channels.isPending) return <PageLoader />;
  if (channels.isError) return <Alert tone="error">{dashboardErrorMessage(channels.error)}</Alert>;
  if (channels.data.length === 0) {
    return <p className="text-muted text-sm">Nenhuma venda no período.</p>;
  }
  const pct = shares(channels.data.map((c) => c.amount_cents));
  return (
    <ul className="space-y-3">
      {channels.data.map((c, i) => (
        <li key={c.channel} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-medium">{channelLabel(c.channel)}</span>
            <span className="text-muted tabular-nums">
              {formatBRL(c.amount_cents)} · {int(c.orders)} pedido(s) · {pct[i]}%
            </span>
          </div>
          <div className="bg-surface-2 h-2 overflow-hidden rounded-full" aria-hidden>
            <div className="bg-brand h-full rounded-full" style={{ width: `${pct[i]}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Suggestions({ orgId }: { orgId: string }) {
  const suggestions = useSuggestions(orgId);
  if (suggestions.isPending) return <PageLoader />;
  if (suggestions.isError) {
    return <Alert tone="error">{dashboardErrorMessage(suggestions.error)}</Alert>;
  }
  if (suggestions.data.length === 0) {
    return (
      <p className="text-muted text-sm">
        Nenhuma sugestão agora: os anúncios com estoque e preço sugerido já estão no seu catálogo,
        ou ainda não há anúncios assim.{' '}
        <Link to="/catalogo" className="text-brand font-medium hover:underline">
          Ver catálogo
        </Link>
      </p>
    );
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {suggestions.data.map((s) => (
        <li key={s.listing_id}>
          <Link
            to={`/catalogo/${s.listing_id}`}
            className="border-border hover:border-brand/50 flex gap-3 rounded-xl border p-3 transition-colors"
          >
            <div className="bg-surface-2 flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg">
              {s.cover_url ? (
                <img src={s.cover_url} alt="" className="size-full object-cover" />
              ) : (
                <ImageOff className="text-muted size-5" aria-hidden />
              )}
            </div>
            <div className="min-w-0 flex-1 text-sm">
              <p className="truncate font-medium">{s.name}</p>
              <p className="text-muted truncate text-xs">{s.supplier_name}</p>
              <p className="mt-1 tabular-nums">
                {formatBRL(s.wholesale_price_cents)} →{' '}
                <span className="font-medium">{formatBRL(s.suggested_price_cents)}</span>
              </p>
              <p className="text-success text-xs font-medium">
                Margem sugerida {percent(s.margin_bps)} · {int(s.available)} em estoque
              </p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

const suggestionsSection = (orgId: string) => (
  <Section
    title="O que vender"
    description="Anúncios do catálogo com estoque, ainda não importados, pela margem entre o atacado e o preço sugerido pelo fornecedor (antes de taxas e frete)."
  >
    <Suggestions orgId={orgId} />
  </Section>
);

/** Painel do vendedor: números de dinheiro só para owner/admin (o banco também recusa). */
export function SellerDashboard({ orgId, role }: { orgId: string; role: OrgRole }) {
  const [days, setDays] = useState(30);

  if (!orgPermissions.viewAnalytics(role)) {
    return (
      <>
        <Alert tone="info">
          Vendas e valores são visíveis apenas para proprietários e administradores.
        </Alert>
        {suggestionsSection(orgId)}
      </>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Seu painel</h2>
          <p className="text-muted text-sm">
            Valores do período escolhido; &quot;hoje&quot; indica a situação atual.
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

      <SummaryCards orgId={orgId} days={days} />

      <Section title="Vendas" description="Total dos pedidos (com frete), sem cancelados.">
        <SalesChart orgId={orgId} />
      </Section>

      <Section
        title="Vendas por canal"
        description="Pedido manual ou canal conectado que trouxe o pedido, no período."
      >
        <Channels orgId={orgId} days={days} />
      </Section>

      {suggestionsSection(orgId)}
    </>
  );
}
