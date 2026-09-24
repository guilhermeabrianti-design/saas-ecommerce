import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { formatBps } from '@/features/fees/fees';
import { cn } from '@/utils/cn';
import { formatBRL } from '@/utils/money';
import { pricingLines, toolsErrorMessage, type Pricing } from '../tools';

/** Detalhamento de uma venda unitária: do preço até o lucro. */
export function PricingResult({
  query,
  headline,
}: {
  query: { data?: Pricing | undefined; isFetching: boolean; isError: boolean; error: unknown };
  headline: 'price' | 'profit';
}) {
  if (query.isError) return <Alert tone="error">{toolsErrorMessage(query.error)}</Alert>;
  if (!query.data) return query.isFetching ? <PageLoader /> : null;

  const p = query.data;
  const loss = p.profit_cents < 0;
  return (
    <div className={cn('space-y-4 transition-opacity', query.isFetching && 'opacity-60')}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="border-border bg-surface rounded-xl border px-4 py-3">
          <p className="text-muted text-xs">
            {headline === 'price' ? 'Preço mínimo de venda' : 'Lucro por unidade'}
          </p>
          <p
            className={cn(
              'text-3xl font-semibold tabular-nums',
              headline === 'profit' && loss && 'text-danger',
            )}
            aria-live="polite"
          >
            {formatBRL(headline === 'price' ? p.price_cents : p.profit_cents)}
          </p>
        </div>
        <div className="border-border bg-surface rounded-xl border px-4 py-3">
          <p className="text-muted text-xs">
            {headline === 'price' ? 'Lucro por unidade' : 'Margem sobre o preço'}
          </p>
          <p className={cn('text-3xl font-semibold tabular-nums', loss && 'text-danger')}>
            {headline === 'price' ? formatBRL(p.profit_cents) : formatBps(p.margin_bps)}
          </p>
          {headline === 'price' && (
            <p className="text-muted text-xs">Margem de {formatBps(p.margin_bps)}</p>
          )}
        </div>
      </div>

      <table className="w-full text-sm">
        <caption className="sr-only">Detalhamento da venda</caption>
        <tbody className="divide-border divide-y">
          {pricingLines(p).map((l) => (
            <tr key={l.label}>
              <th scope="row" className="text-muted py-2 text-left font-normal">
                {l.label}
              </th>
              <td className="py-2 text-right tabular-nums">
                {l.sign < 0 ? '− ' : ''}
                {formatBRL(l.cents)}
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row" className="py-2 text-left font-semibold">
              {loss ? 'Prejuízo' : 'Lucro'}
            </th>
            <td className={cn('py-2 text-right font-semibold tabular-nums', loss && 'text-danger')}>
              {formatBRL(p.profit_cents)}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="text-muted text-xs">
        Taxa: {formatBps(p.fee_rule.percent_bps)}
        {p.fee_rule.fixed_cents_per_item > 0 &&
          ` + ${formatBRL(p.fee_rule.fixed_cents_per_item)} por item`}{' '}
        ({p.fee_rule.label}), cadastrada pela equipe TheSigns. Confira na tabela oficial do
        marketplace.
      </p>
    </div>
  );
}
