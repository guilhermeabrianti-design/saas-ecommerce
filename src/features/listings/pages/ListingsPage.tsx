import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ExternalLink } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { useOrganization } from '@/features/organizations/organization-context';
import { orgPermissions } from '@/features/organizations/roles';
import { cn } from '@/utils/cn';
import { formatBRL } from '@/utils/money';
import {
  useChannelListings,
  useListableProducts,
  usePublishableConnections,
  useSaveListing,
} from '../api';
import {
  listingErrorMessage,
  listingStatusLabels,
  listingStatusTone,
  listingStatuses,
  providerLabels,
  type ListingStatus,
} from '../listings';

function NewListing({ orgId }: { orgId: string }) {
  const connections = usePublishableConnections(orgId);
  const products = useListableProducts(orgId);
  const save = useSaveListing(orgId);
  const navigate = useNavigate();
  const [connectionId, setConnectionId] = useState('');
  const [productId, setProductId] = useState('');

  if (connections.isPending || products.isPending) return <PageLoader />;
  if (!connections.data?.length) {
    return (
      <p className="text-muted text-sm">
        Conecte uma loja Shopify ou WooCommerce em{' '}
        <Link to="/integracoes" className="text-brand hover:underline">
          Integrações
        </Link>{' '}
        (com as credenciais de API) para anunciar.
      </p>
    );
  }
  const product = products.data?.find((p) => p.id === productId);
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!product || !connectionId) return;
        save.mutate(
          {
            id: null,
            connectionId,
            productId: product.id,
            title: product.name,
            description: product.description ?? '',
            priceCents: null,
          },
          { onSuccess: (id) => void navigate(`/anuncios/${id}`) },
        );
      }}
    >
      {save.isError && <Alert tone="error">{listingErrorMessage(save.error)}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="Loja" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
          <option value="">Escolha…</option>
          {connections.data.map((c) => (
            <option key={c.id} value={c.id} disabled={c.status !== 'active'}>
              {c.name} ({providerLabels[c.provider] ?? c.provider})
              {c.status !== 'active' ? ' — pausada' : ''}
            </option>
          ))}
        </Select>
        <Select label="Produto" value={productId} onChange={(e) => setProductId(e.target.value)}>
          <option value="">Escolha…</option>
          {(products.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.sku}){p.source_listing_id ? ' · fornecedor' : ''}
              {p.status !== 'active' ? ' — inativo' : ''}
            </option>
          ))}
        </Select>
      </div>
      <Button type="submit" disabled={!product || !connectionId} loading={save.isPending}>
        Criar rascunho
      </Button>
    </form>
  );
}

export function ListingsPage() {
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const allowed = orgPermissions.manageIntegrations(active!.role);
  const listings = useChannelListings(orgId);
  const [status, setStatus] = useState<ListingStatus | ''>('');

  if (!allowed) {
    return (
      <div className="mx-auto max-w-3xl">
        <Alert tone="info">Anúncios são gerenciados por proprietários e administradores.</Alert>
      </div>
    );
  }

  const rows = (listings.data ?? []).filter((l) => !status || l.status === status);
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Anúncios</h1>
        <p className="text-muted text-sm">
          Publique seus produtos na Shopify e no WooCommerce. Ao publicar, os SKUs ficam vinculados:
          pedidos entram sozinhos e o estoque sincroniza (inclusive o do fornecedor).
        </p>
      </div>

      <Section
        title="Novo anúncio"
        description="Escolha a loja e o produto; você revisa antes de publicar."
      >
        <NewListing orgId={orgId} />
      </Section>

      <Section title="Seus anúncios" description="Mais recentes primeiro.">
        <div className="mb-4 w-48">
          <Select
            label="Situação"
            value={status}
            onChange={(e) => setStatus(e.target.value as ListingStatus | '')}
          >
            <option value="">Todas</option>
            {listingStatuses.map((s) => (
              <option key={s} value={s}>
                {listingStatusLabels[s]}
              </option>
            ))}
          </Select>
        </div>
        {listings.isPending ? (
          <PageLoader />
        ) : listings.isError ? (
          <Alert tone="error">{listingErrorMessage(listings.error)}</Alert>
        ) : rows.length === 0 ? (
          <p className="text-muted text-sm">Nenhum anúncio aqui.</p>
        ) : (
          <ul className="divide-border -mx-5 divide-y">
            {rows.map((l) => (
              <li
                key={l.id}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
              >
                <Link to={`/anuncios/${l.id}`} className="min-w-0 flex-1 hover:underline">
                  <span className="block truncate text-sm font-medium">{l.title}</span>
                  <span className="text-muted block text-xs">
                    {l.integration_connections?.name ?? '—'} ·{' '}
                    {providerLabels[l.integration_connections?.provider ?? ''] ?? ''} · SKU{' '}
                    {l.products?.sku}
                    {l.price_cents != null && ` · ${formatBRL(l.price_cents)}`}
                  </span>
                  {l.last_error && (
                    <span className="text-danger block text-xs">{l.last_error}</span>
                  )}
                </Link>
                {l.external_url && (
                  <a
                    href={l.external_url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-muted hover:text-fg"
                    aria-label="Abrir no marketplace"
                  >
                    <ExternalLink className="size-4" aria-hidden />
                  </a>
                )}
                <span
                  className={cn(
                    'rounded px-2 py-0.5 text-xs font-medium',
                    listingStatusTone[l.status],
                  )}
                >
                  {listingStatusLabels[l.status]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
