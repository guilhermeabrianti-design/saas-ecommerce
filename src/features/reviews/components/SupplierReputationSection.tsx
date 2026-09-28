import { Section } from '@/components/ui/Section';
import { useListingSupplierReputation } from '../api';
import { ReputationSummary, ReviewList } from './ReputationView';

/** Reputação do fornecedor na página do anúncio do catálogo. */
export function SupplierReputationSection({ listingId }: { listingId: string }) {
  const rep = useListingSupplierReputation(listingId);
  if (!rep.data) return null;
  return (
    <Section
      title={`Reputação de ${rep.data.name}`}
      description="Notas de outros vendedores e métricas dos pedidos dos últimos 90 dias."
    >
      <div className="space-y-6">
        <ReputationSummary r={rep.data} />
        {rep.data.reviews.length > 0 && <ReviewList reviews={rep.data.reviews} canReply={false} />}
      </div>
    </Section>
  );
}
