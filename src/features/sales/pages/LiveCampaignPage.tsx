import { Link, useParams } from 'react-router';
import { ArrowLeft, ImageOff } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { providerLabels } from '@/features/integrations/schemas';
import { useOrganization } from '@/features/organizations/organization-context';
import { orgPermissions } from '@/features/organizations/roles';
import { formatBRL } from '@/utils/money';
import { useLiveCampaign, useSetParticipation } from '../api';
import {
  campaignPhase,
  campaignPhaseLabels,
  formatBps,
  formatPeriod,
  salesErrorMessage,
} from '../sales';

export function LiveCampaignPage() {
  const { campaignId = '' } = useParams();
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const campaign = useLiveCampaign(orgId, campaignId);
  const participation = useSetParticipation(orgId);
  const canJoin = orgPermissions.joinCampaigns(active!.role);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link
        to="/central/lives"
        className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Campanhas para lives
      </Link>

      {campaign.isPending ? (
        <PageLoader />
      ) : campaign.isError ? (
        <Alert tone="error">{salesErrorMessage(campaign.error)}</Alert>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-brand font-mono text-xs font-medium tracking-widest uppercase">
                {campaignPhaseLabels[campaignPhase(campaign.data.starts_at, campaign.data.ends_at)]}
              </p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">{campaign.data.name}</h1>
              <p className="text-muted mt-1 text-sm">
                {formatPeriod(campaign.data.starts_at, campaign.data.ends_at)}
                {campaign.data.provider && ` · ${providerLabels[campaign.data.provider]}`}
              </p>
            </div>
            {canJoin ? (
              <Button
                variant={campaign.data.joined ? 'secondary' : 'primary'}
                loading={participation.isPending}
                onClick={() => participation.mutate({ campaignId, join: !campaign.data.joined })}
              >
                {campaign.data.joined ? 'Sair da campanha' : 'Participar'}
              </Button>
            ) : (
              <p className="text-muted max-w-60 text-sm">
                {campaign.data.joined
                  ? 'Sua loja participa desta campanha.'
                  : 'Proprietários e administradores inscrevem a loja.'}
              </p>
            )}
          </div>

          {participation.isError && (
            <Alert tone="error">{salesErrorMessage(participation.error)}</Alert>
          )}

          <Alert tone={campaign.data.joined ? 'success' : 'info'}>
            {campaign.data.commission_bps === null
              ? 'Esta campanha não muda a comissão: valem as regras normais.'
              : campaign.data.joined
                ? `Sua loja participa: enquanto a campanha estiver no ar${
                    campaign.data.provider ? ` no ${providerLabels[campaign.data.provider]}` : ''
                  }, a comissão dos produtos abaixo é ${formatBps(campaign.data.commission_bps)}. A calculadora de venda de cada produto já considera isso.`
                : `Participando, a comissão dos produtos abaixo passa a ${formatBps(campaign.data.commission_bps)} enquanto a campanha estiver no ar.`}
          </Alert>

          {campaign.data.description && (
            <p className="text-sm whitespace-pre-wrap">{campaign.data.description}</p>
          )}

          <Section
            title="Produtos da campanha"
            description="Abra um produto para ver os materiais de divulgação."
          >
            {campaign.data.listings.length === 0 ? (
              <p className="text-muted text-sm">Nenhum produto disponível no catálogo agora.</p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2">
                {campaign.data.listings.map((l) => (
                  <li key={l.listing_id}>
                    <Link
                      to={`/central/${l.listing_id}`}
                      className="border-border hover:border-brand/50 flex gap-3 rounded-xl border p-3 transition-colors"
                    >
                      <div className="bg-surface-2 flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg">
                        {l.cover_url ? (
                          <img src={l.cover_url} alt="" className="size-full object-cover" />
                        ) : (
                          <ImageOff className="text-muted size-5" aria-hidden />
                        )}
                      </div>
                      <div className="min-w-0 flex-1 text-sm">
                        <p className="truncate font-medium">{l.name}</p>
                        <p className="text-muted truncate text-xs">{l.supplier_name}</p>
                        <p className="mt-1 tabular-nums">
                          {formatBRL(l.wholesale_price_cents)}
                          {l.suggested_price_cents !== null &&
                            ` → ${formatBRL(l.suggested_price_cents)}`}
                        </p>
                        <p className="text-muted text-xs">
                          {l.available > 0 ? `${l.available} em estoque` : 'Sem estoque'} ·{' '}
                          {l.materials} materiais
                        </p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
