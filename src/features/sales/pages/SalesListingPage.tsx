import { Link, useParams } from 'react-router';
import { ArrowLeft, Flame, Radio, Store } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { providerLabels } from '@/features/integrations/schemas';
import { formatBRL } from '@/utils/money';
import { useSalesListing } from '../api';
import { FavoriteButton } from '../components/FavoriteButton';
import { MaterialView } from '../components/MaterialView';
import {
  campaignPhase,
  campaignPhaseLabels,
  formatBps,
  formatPeriod,
  materialKindLabels,
  materialKinds,
  salesErrorMessage,
} from '../sales';

export function SalesListingPage() {
  const { listingId = '' } = useParams();
  const listing = useSalesListing(listingId);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link
        to="/central"
        className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Central de Vendas
      </Link>

      {listing.isPending ? (
        <PageLoader />
      ) : listing.isError ? (
        <Alert tone="error">{salesErrorMessage(listing.error)}</Alert>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight">{listing.data.name}</h1>
              <p className="text-muted mt-1 text-sm">
                {listing.data.supplier_name}
                {listing.data.brand && ` · ${listing.data.brand}`}
              </p>
              <p className="mt-2 text-sm tabular-nums">
                Atacado <strong>{formatBRL(listing.data.wholesale_price_cents)}</strong>
                {listing.data.suggested_price_cents !== null && (
                  <>
                    {' '}
                    · preço sugerido{' '}
                    <strong>{formatBRL(listing.data.suggested_price_cents)}</strong>
                  </>
                )}
                {listing.data.units_30d > 0 && (
                  <span className="text-warning ml-2 inline-flex items-center gap-1">
                    <Flame className="size-3.5" aria-hidden />
                    {listing.data.units_30d.toLocaleString('pt-BR')} vendidos em 30 dias
                  </span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <FavoriteButton
                listingId={listing.data.listing_id}
                favorite={listing.data.is_favorite}
                name={listing.data.name}
              />
              <Link
                to={`/catalogo/${listing.data.listing_id}`}
                className="bg-brand text-brand-fg hover:bg-brand/90 inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium"
              >
                <Store className="size-4" aria-hidden />
                Importar e calcular
              </Link>
            </div>
          </div>

          {listing.data.campaigns.length > 0 && (
            <Section
              title="Campanhas para lives"
              description="Este produto está nestas campanhas. Participe para ganhar a comissão da campanha."
            >
              <ul className="space-y-2">
                {listing.data.campaigns.map((c) => (
                  <li key={c.id}>
                    <Link
                      to={`/central/lives/${c.id}`}
                      className="hover:bg-surface-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-2 text-sm"
                    >
                      <Radio className="text-brand size-4" aria-hidden />
                      <span className="font-medium">{c.name}</span>
                      <span className="text-muted">
                        {campaignPhaseLabels[campaignPhase(c.starts_at, c.ends_at)]} ·{' '}
                        {formatPeriod(c.starts_at, c.ends_at)}
                        {c.provider && ` · ${providerLabels[c.provider]}`}
                      </span>
                      {c.commission_bps !== null && (
                        <span className="text-success font-medium">
                          Comissão {formatBps(c.commission_bps)}
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section
            title="Materiais de divulgação"
            description="Enviados pelo fornecedor. Copie os textos e baixe vídeos e imagens para postar."
          >
            {listing.data.materials.length === 0 ? (
              <p className="text-muted text-sm">
                O fornecedor ainda não enviou materiais para este produto.
              </p>
            ) : (
              <div className="space-y-6">
                {materialKinds.map((kind) => {
                  const items = listing.data.materials.filter((m) => m.kind === kind);
                  if (items.length === 0) return null;
                  return (
                    <div key={kind} className="space-y-3">
                      <h2 className="text-sm font-semibold">
                        {materialKindLabels[kind]} ({items.length})
                      </h2>
                      {items.map((m) => (
                        <MaterialView key={m.id} material={m} />
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          {listing.data.description && (
            <Section title="Descrição do fornecedor" description="Texto do cadastro do produto.">
              <p className="text-sm whitespace-pre-wrap">{listing.data.description}</p>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
