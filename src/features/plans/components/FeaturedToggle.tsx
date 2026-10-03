import { Link } from 'react-router';
import { Gem } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { useFeaturedStatus, useSetFeatured } from '../api';
import { plansErrorMessage } from '../plans';

/** Fornecedor: destaca o anúncio no catálogo, até as vagas do plano. */
export function FeaturedToggle({ listingId, canEdit }: { listingId: string; canEdit: boolean }) {
  const status = useFeaturedStatus(listingId);
  const set = useSetFeatured(listingId);
  if (status.isPending || status.isError) return null;
  const s = status.data;

  return (
    <div className="border-border space-y-2 rounded-lg border px-3.5 py-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <Gem className="text-brand size-4" aria-hidden />
        Destaque no catálogo
      </p>
      <p className="text-muted">
        {s.slots === 0
          ? 'Seu plano não inclui destaques. '
          : `Vagas do plano: ${s.used} de ${s.slots} em uso. `}
        Destacados aparecem primeiro para os vendedores, com selo.
      </p>
      {s.marked && !s.active && (
        <p className="text-danger">
          Marcado, mas fora das vagas do plano atual: não aparece como destaque.
        </p>
      )}
      {canEdit &&
        (s.marked ? (
          <Button variant="secondary" loading={set.isPending} onClick={() => set.mutate(false)}>
            Tirar destaque
          </Button>
        ) : s.used < s.slots ? (
          <Button variant="secondary" loading={set.isPending} onClick={() => set.mutate(true)}>
            Destacar este produto
          </Button>
        ) : (
          <Link to="/plano" className="text-brand underline">
            Ver planos com destaque
          </Link>
        ))}
      {set.isError && <Alert tone="error">{plansErrorMessage(set.error)}</Alert>}
    </div>
  );
}
