import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { barHeights } from '@/features/analytics/api';
import { cn } from '@/utils/cn';
import { formatBRL } from '@/utils/money';
import { dashboardErrorMessage, useSeries } from '../api';
import { bucketDays, bucketLabels, buckets, periodLabel, type Bucket } from '../dashboard';

const windowLabel: Record<Bucket, string> = {
  day: 'últimos 30 dias',
  week: 'últimas 12 semanas',
  month: 'últimos 12 meses',
};

/** Vendas agrupadas por dia, semana ou mês (o primeiro balde pode ser parcial). */
export function SalesChart({ orgId }: { orgId: string }) {
  const [bucket, setBucket] = useState<Bucket>('day');
  const series = useSeries(orgId, bucketDays[bucket], bucket);

  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="Agrupar vendas" className="flex gap-1">
        {buckets.map((b) => (
          <button
            key={b}
            type="button"
            role="radio"
            aria-checked={bucket === b}
            onClick={() => setBucket(b)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
              bucket === b ? 'bg-brand/10 text-brand' : 'text-muted hover:bg-surface-2',
            )}
          >
            {bucketLabels[b]}
          </button>
        ))}
      </div>

      {series.isPending ? (
        <PageLoader />
      ) : series.isError ? (
        <Alert tone="error">{dashboardErrorMessage(series.error)}</Alert>
      ) : (
        <Bars points={series.data} bucket={bucket} />
      )}
    </div>
  );
}

function Bars({
  points,
  bucket,
}: {
  points: { period_start: string; orders: number; amount_cents: number }[];
  bucket: Bucket;
}) {
  const total = points.reduce((s, p) => s + p.amount_cents, 0);
  if (points.length === 0 || total === 0) {
    return <p className="text-muted text-sm">Sem vendas nos {windowLabel[bucket]}.</p>;
  }
  const heights = barHeights(points.map((p) => p.amount_cents));
  const orders = points.reduce((s, p) => s + p.orders, 0);

  return (
    <figure className="space-y-2">
      <div
        role="img"
        aria-label={`Vendas ${bucketLabels[bucket].toLowerCase()} nos ${windowLabel[bucket]}: ${formatBRL(total)} em ${orders} pedido(s)`}
        className={cn('flex h-40 items-end', points.length > 40 ? 'gap-px' : 'gap-1')}
      >
        {points.map((p, i) => (
          <div
            key={p.period_start}
            title={`${periodLabel(p.period_start, bucket)} · ${formatBRL(p.amount_cents)} · ${p.orders} pedido(s)`}
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
        <span>{periodLabel(points[0]!.period_start, bucket)}</span>
        <span>
          {formatBRL(total)} · {orders} pedido(s)
        </span>
        <span>{periodLabel(points[points.length - 1]!.period_start, bucket)}</span>
      </figcaption>
    </figure>
  );
}
