import { Link, useSearchParams } from 'react-router';
import { ChevronRight } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { useOrganization } from '@/features/organizations/organization-context';
import { orgPermissions } from '@/features/organizations/roles';
import { integrationErrorMessage, useConnections } from '../api';
import { ConnectionStatusBadge } from '../components/ConnectionStatusBadge';
import { MercadoLivreConnect } from '../components/MercadoLivreConnect';
import { mercadoLivreReturnMessages } from '../mercadolivre';
import { providerLabels } from '../schemas';

export function IntegrationsPage() {
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const connections = useConnections(orgId);
  const [params] = useSearchParams();
  const mlReturn = mercadoLivreReturnMessages[params.get('ml') ?? ''];

  if (!orgPermissions.manageIntegrations(active!.role)) {
    return (
      <div className="mx-auto max-w-3xl">
        <Alert tone="info">
          As integrações são gerenciadas por proprietários e administradores.
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Integrações</h1>
        <p className="text-muted text-sm">
          Mercado Livre, Shopee e TikTok Shop: pedidos entram sozinhos e o estoque fica em dia.
        </p>
      </div>

      <Section title="Conexões" description="Contas de marketplace ligadas à sua loja.">
        {connections.isPending ? (
          <PageLoader />
        ) : connections.isError ? (
          <Alert tone="error">{integrationErrorMessage(connections.error)}</Alert>
        ) : connections.data.length === 0 ? (
          <p className="text-muted text-sm">Nenhuma conexão ainda. Crie a primeira abaixo.</p>
        ) : (
          <ul className="divide-border -my-3 divide-y text-sm">
            {connections.data.map((c) => (
              <li key={c.id}>
                <Link
                  to={`/integracoes/${c.id}`}
                  className="hover:bg-surface-2 -mx-2 flex items-center gap-3 rounded-lg px-2 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{c.name}</p>
                    <p className="text-muted truncate text-xs">
                      {providerLabels[c.provider]} · {c.external_account_id}
                    </p>
                  </div>
                  <ConnectionStatusBadge status={c.status} />
                  <ChevronRight className="text-muted size-4" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {mlReturn && <Alert tone={mlReturn.tone}>{mlReturn.text}</Alert>}

      <Section
        title="Mercado Livre"
        description="Pedidos pagos entram sozinhos (Mercado Envios; Full fica com o Mercado Livre) e o estoque sincroniza pelos SKUs."
      >
        <MercadoLivreConnect orgId={orgId} />
      </Section>

      <Section
        title="Shopee e TikTok Shop"
        description="Em preparação: dependem da aprovação do app de cada plataforma."
      >
        <p className="text-muted text-sm">
          Assim que liberadas, a conexão será feita por autorização, como no Mercado Livre.
        </p>
      </Section>
    </div>
  );
}
