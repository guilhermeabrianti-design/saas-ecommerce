import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Section } from '@/components/ui/Section';
import { StarInput, Stars } from '@/features/reviews/components/Stars';
import { reviewErrorMessage } from '@/features/reviews/reviews';
import { useSubmitReview } from '../api';
import type { CheckoutOrderStatus } from '../checkout';

/** Avaliação da loja pelo comprador (depois do envio), no acompanhamento do pedido. */
export function BuyerReview({ token, s }: { token: string; s: CheckoutOrderStatus }) {
  const submit = useSubmitReview(token);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');

  if (s.review) {
    return (
      <Section title="Sua avaliação" description="Obrigado por contar como foi.">
        <div className="space-y-2 text-sm">
          <Stars value={s.review.rating} />
          {s.review.comment && <p className="whitespace-pre-line">{s.review.comment}</p>}
          {s.review.reply && (
            <p className="text-muted">
              Resposta de {s.store_name}: {s.review.reply}
            </p>
          )}
        </div>
      </Section>
    );
  }
  if (!s.can_review) return null;

  return (
    <Section
      title="Avalie sua compra"
      description={`Sua nota ajuda outros compradores de ${s.store_name}. Aparece só o seu primeiro nome.`}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (rating) submit.mutate({ rating, comment });
        }}
      >
        {submit.isError && <Alert tone="error">{reviewErrorMessage(submit.error)}</Alert>}
        <StarInput value={rating} onChange={setRating} />
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          maxLength={1000}
          placeholder="Como foi a compra e o produto? (opcional)"
          aria-label="Comentário"
          className="border-border bg-surface w-full rounded-lg border px-3 py-2 text-sm"
        />
        <Button type="submit" disabled={!rating} loading={submit.isPending}>
          Enviar avaliação
        </Button>
      </form>
    </Section>
  );
}
