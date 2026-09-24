import { Link } from 'react-router';
import { ArrowLeft, ChevronRight, Radio } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { providerLabels } from '@/features/integrations/schemas';
import { useOrganization } from '@/features/organizations/organization-context';
import { cn } from '@/utils/cn';
import { useLiveCampaigns } from '../api';
import {
  campaignPhase,
  campaignPhaseLabels,
  formatBps,
  formatPeriod,
  salesErrorMessage,
} from '../sales';

export function LiveCampaignsPage() {
  const { active } = useOrganization();
  const campaigns = useLiveCampaigns(active!.organization.id);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        to="/central"
        className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Central de Vendas
      </Link>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Campanhas para lives</h1>
        <p className="text-muted mt-1 text-sm">
          Campanhas da TheSigns com produtos selecionados, período e comissão própria. Participe
          para vender com a comissão da campanha enquanto ela estiver no ar.
        </p>
      </div>

      {campaigns.isPending ? (
        <PageLoader />
      ) : campaigns.isError ? (
        <Alert tone="error">{salesErrorMessage(campaigns.error)}</Alert>
      ) : campaigns.data.length === 0 ? (
        <div className="border-border rounded-xl border border-dashed px-6 py-16 text-center">
          <Radio className="text-muted mx-auto size-8" aria-hidden />
          <p className="mt-3 font-medium">Nenhuma campanha aberta agora</p>
          <p className="text-muted mt-1 text-sm">
            Quando a equipe publicar uma campanha, ela aparecerá aqui.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {campaigns.data.map((c) => {
            const phase = campaignPhase(c.starts_at, c.ends_at);
            return (
              <li key={c.id}>
                <Link
                  to={`/central/lives/${c.id}`}
                  className="border-border bg-surface hover:border-brand/50 flex items-center gap-4 rounded-xl border px-4 py-4 transition-colors"
                >
                  <Radio
                    className={cn(
                      'size-5 shrink-0',
                      phase === 'live' ? 'text-danger' : 'text-brand',
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {c.name}
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-xs',
                          phase === 'live' ? 'bg-danger/10 text-danger' : 'bg-surface-2 text-muted',
                        )}
                      >
                        {campaignPhaseLabels[phase]}
                      </span>
                      {c.joined && (
                        <span className="bg-success/10 text-success rounded-full px-2 py-0.5 text-xs">
                          Participando
                        </span>
                      )}
                    </p>
                    <p className="text-muted text-sm">
                      {formatPeriod(c.starts_at, c.ends_at)}
                      {c.provider && ` · ${providerLabels[c.provider]}`} ·{' '}
                      {c.listings.toLocaleString('pt-BR')} produto(s)
                      {c.commission_bps !== null && ` · comissão ${formatBps(c.commission_bps)}`}
                    </p>
                  </div>
                  <ChevronRight className="text-muted size-4" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
