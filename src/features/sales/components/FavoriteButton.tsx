import { Heart } from 'lucide-react';
import { cn } from '@/utils/cn';
import { useToggleFavorite } from '../api';

export function FavoriteButton({
  listingId,
  favorite,
  name,
  className,
}: {
  listingId: string;
  favorite: boolean;
  name: string;
  className?: string;
}) {
  const toggle = useToggleFavorite();
  // Mostra o estado pretendido enquanto salva.
  const shown = toggle.isPending ? toggle.variables.favorite : favorite;
  return (
    <button
      type="button"
      aria-pressed={shown}
      aria-label={shown ? `Remover ${name} dos favoritos` : `Favoritar ${name}`}
      title={toggle.isError ? 'Não foi possível salvar. Tente de novo.' : undefined}
      disabled={toggle.isPending}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle.mutate({ listingId, favorite: !favorite });
      }}
      className={cn(
        'bg-surface/90 border-border hover:text-danger inline-flex size-9 items-center justify-center rounded-full border transition-colors',
        shown ? 'text-danger' : 'text-muted',
        toggle.isError && 'ring-danger ring-2',
        className,
      )}
    >
      <Heart className={cn('size-4', shown && 'fill-current')} aria-hidden />
    </button>
  );
}
