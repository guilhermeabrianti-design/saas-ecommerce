import { Link } from 'react-router';
import { ChevronRight, Plus } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { providerLabels } from '@/features/integrations/schemas';
import { cn } from '@/utils/cn';
import { useAdminCampaigns } from '../api';
import {
  campaignPhase,
  campaignPhaseLabels,
  campaignStatusLabels,
  formatBps,
  formatPeriod,
  salesErrorMessage,
} from '../sales';

export function LiveCampaignsAdminPage() {
  const campaigns = useAdminCampaigns();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Campanhas para lives</h1>
          <p className="text-muted mt-1 text-sm">
            Período, produtos e comissão do vendedor participante. Alterações são auditadas.
          </p>
        </div>
        <Link
          to="/admin/lives/nova"
          className="bg-brand text-brand-fg hover:bg-brand/90 inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium"
        >
          <Plus className="size-4" aria-hidden />
          Nova campanha
        </Link>
      </div>

      {campaigns.isPending ? (
        <PageLoader />
      ) : campaigns.isError ? (
        <Alert tone="error">{salesErrorMessage(campaigns.error)}</Alert>
      ) : campaigns.data.length === 0 ? (
        <p className="text-muted text-sm">Nenhuma campanha criada.</p>
      ) : (
        <ul className="border-border bg-surface divide-border divide-y rounded-xl border">
          {campaigns.data.map((c) => (
            <li key={c.id}>
              <Link
                to={`/admin/lives/${c.id}`}
                className="hover:bg-surface-2 flex items-center gap-4 px-4 py-3"
              >
                <div className="min-w-0 flex-1 space-y-0.5 text-sm">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {c.name}
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-xs',
                        c.status === 'published'
                          ? 'bg-success/10 text-success'
                          : 'bg-surface-2 text-muted',
                      )}
                    >
                      {campaignStatusLabels[c.status]}
                      {c.status === 'published' &&
                        ` · ${campaignPhaseLabels[campaignPhase(c.starts_at, c.ends_at)]}`}
                    </span>
                  </p>
                  <p className="text-muted">
                    {formatPeriod(c.starts_at, c.ends_at)}
                    {c.provider && ` · ${providerLabels[c.provider]}`} · {c.listings} produto(s) ·{' '}
                    {c.participants} loja(s) ·{' '}
                    {c.commission_bps === null
                      ? 'comissão das regras'
                      : `comissão ${formatBps(c.commission_bps)}`}
                  </p>
                </div>
                <ChevronRight className="text-muted size-4" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
