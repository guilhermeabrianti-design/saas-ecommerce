import { Star } from 'lucide-react';
import { cn } from '@/utils/cn';
import { formatRating, reviewCountLabel, type RatingSummary } from '../reviews';

/** Estrelas somente leitura. */
export function Stars({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn('inline-flex', className)} role="img" aria-label={`${value} de 5 estrelas`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={cn(
            'size-4',
            n <= Math.round(value) ? 'fill-warning text-warning' : 'text-border',
          )}
          aria-hidden
        />
      ))}
    </span>
  );
}

/** "4,5 ★★★★☆ (12 avaliações)" — some quando não há avaliações. */
export function RatingBadge({ rating }: { rating: RatingSummary | null | undefined }) {
  if (!rating || rating.rating_count === 0 || rating.rating_avg == null) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span className="font-semibold tabular-nums">{formatRating(rating.rating_avg)}</span>
      <Stars value={rating.rating_avg} />
      <span className="text-muted">({reviewCountLabel(rating.rating_count)})</span>
    </span>
  );
}

/** Escolha de 1 a 5 estrelas. */
export function StarInput({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex gap-1" role="radiogroup" aria-label="Nota">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} ${n === 1 ? 'estrela' : 'estrelas'}`}
          onClick={() => onChange(n)}
          className="focus-visible:ring-brand/50 rounded focus-visible:ring-2 focus-visible:outline-none"
        >
          <Star
            className={cn('size-7', n <= value ? 'fill-warning text-warning' : 'text-border')}
            aria-hidden
          />
        </button>
      ))}
    </div>
  );
}
