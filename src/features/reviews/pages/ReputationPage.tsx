import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { useOrganization } from '@/features/organizations/organization-context';
import { REVIEWS_PAGE_SIZE, useReputation } from '../api';
import { ReputationSummary, ReviewList } from '../components/ReputationView';
import { reviewErrorMessage } from '../reviews';

export function ReputationPage() {
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const isSupplier = active!.organization.kind === 'supplier';
  const [page, setPage] = useState(1);
  const rep = useReputation(orgId, page);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reputação</h1>
        <p className="text-muted text-sm">
          {isSupplier
            ? 'Notas dos vendedores e métricas dos seus pedidos de fornecimento. Vendedores veem isto ao escolher produtos no catálogo.'
            : 'Notas dos compradores do checkout e métricas das suas vendas. A nota aparece na sua vitrine e nas páginas de compra.'}
        </p>
      </div>
      {rep.isPending ? (
        <PageLoader />
      ) : rep.isError ? (
        <Alert tone="error">{reviewErrorMessage(rep.error)}</Alert>
      ) : (
        <>
          <Section
            title="Resumo"
            description="Métricas dos últimos 90 dias; notas de todo o período."
          >
            <ReputationSummary r={rep.data} />
          </Section>
          <Section
            title="Avaliações"
            description="Só quem comprou ou recebeu de verdade avalia. Você pode responder uma vez."
          >
            <ReviewList reviews={rep.data.reviews} canReply={rep.data.can_reply} />
            {(page > 1 || rep.data.reviews.length === REVIEWS_PAGE_SIZE) && (
              <nav className="mt-4 flex gap-2" aria-label="Paginação">
                <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Mais recentes
                </Button>
                <Button
                  variant="secondary"
                  disabled={rep.data.reviews.length !== REVIEWS_PAGE_SIZE}
                  onClick={() => setPage(page + 1)}
                >
                  Mais antigas
                </Button>
              </nav>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
