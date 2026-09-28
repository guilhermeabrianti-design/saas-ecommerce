import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { useReplyReview } from '../api';
import {
  MIN_ORDERS_FOR_RATES,
  formatRating,
  metricRates,
  reviewCountLabel,
  reviewErrorMessage,
  type Reputation,
  type Review,
} from '../reviews';
import { Stars } from './Stars';

const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

function ReplyForm({ review }: { review: Review }) {
  const reply = useReplyReview();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  if (!open) {
    return (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Responder
      </Button>
    );
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) reply.mutate({ id: review.id, reply: text.trim() });
      }}
    >
      {reply.isError && <Alert tone="error">{reviewErrorMessage(reply.error)}</Alert>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        maxLength={1000}
        aria-label="Sua resposta"
        className="border-border bg-surface w-full rounded-lg border px-3 py-2 text-sm"
      />
      <p className="text-muted text-xs">A resposta é pública e só pode ser enviada uma vez.</p>
      <div className="flex gap-2">
        <Button type="submit" disabled={!text.trim()} loading={reply.isPending}>
          Publicar resposta
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

export function ReviewList({ reviews, canReply }: { reviews: Review[]; canReply: boolean }) {
  if (!reviews.length) return <p className="text-muted text-sm">Nenhuma avaliação ainda.</p>;
  return (
    <ul className="divide-border divide-y">
      {reviews.map((r) => (
        <li key={r.id} className="space-y-2 py-4 first:pt-0">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Stars value={r.rating} />
            <span className="font-medium">{r.reviewer_label}</span>
            <span className="text-muted">
              · {day(r.created_at)}
              {r.product_name && ` · ${r.product_name}`}
            </span>
          </div>
          {r.comment && <p className="text-sm whitespace-pre-line">{r.comment}</p>}
          {r.reply ? (
            <div className="border-border bg-surface-2 rounded-lg border-l-4 px-3 py-2 text-sm">
              <p className="text-muted text-xs">
                Resposta{r.replied_at && ` · ${day(r.replied_at)}`}
              </p>
              <p className="whitespace-pre-line">{r.reply}</p>
            </div>
          ) : (
            canReply && <ReplyForm review={r} />
          )}
        </li>
      ))}
    </ul>
  );
}

/** Nota, distribuição e métricas objetivas. */
export function ReputationSummary({ r }: { r: Reputation }) {
  const rates = metricRates(r);
  const total = r.rating_count || 1;
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="space-y-3">
        <div className="flex items-end gap-3">
          <span className="text-4xl font-semibold tabular-nums">{formatRating(r.rating_avg)}</span>
          <div className="pb-1">
            {r.rating_avg != null && <Stars value={r.rating_avg} />}
            <p className="text-muted text-xs">{reviewCountLabel(r.rating_count)}</p>
          </div>
        </div>
        <ul className="space-y-1 text-xs" aria-label="Distribuição das notas">
          {[5, 4, 3, 2, 1].map((n) => {
            const count = r.distribution[String(n)] ?? 0;
            return (
              <li key={n} className="flex items-center gap-2">
                <span className="w-3 tabular-nums">{n}</span>
                <span className="bg-surface-2 h-2 flex-1 overflow-hidden rounded">
                  <span
                    className="bg-warning block h-full"
                    style={{ width: `${(count / total) * 100}%` }}
                  />
                </span>
                <span className="text-muted w-6 text-right tabular-nums">{count}</span>
              </li>
            );
          })}
        </ul>
      </div>
      <div>
        {rates.length ? (
          <dl className="grid gap-3 sm:grid-cols-2">
            {rates.map((m) => (
              <div key={m.label} className="border-border rounded-lg border px-3 py-2">
                <dt className="text-muted text-xs">{m.label}</dt>
                <dd className="text-lg font-semibold tabular-nums">{m.value}</dd>
                <p className="text-muted text-xs">{m.hint}</p>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-muted text-sm">
            As taxas de envio e cancelamento aparecem a partir de {MIN_ORDERS_FOR_RATES} pedidos nos
            últimos 90 dias.
          </p>
        )}
      </div>
    </div>
  );
}
