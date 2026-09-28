import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { useReviewSupplierOrder } from '../api';
import { reviewErrorMessage } from '../reviews';
import { StarInput, Stars } from './Stars';

/** Avaliação do fornecedor num pedido de fornecimento enviado (vendedor owner/admin). */
export function SupplierReviewForm({
  orderId,
  supplierOrderId,
  existing,
}: {
  orderId: string;
  supplierOrderId: string;
  existing: { rating: number; comment: string | null } | undefined;
}) {
  const save = useReviewSupplierOrder(orderId);
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');

  if (existing) {
    return (
      <p className="text-muted flex items-center gap-2 text-xs">
        Sua avaliação: <Stars value={existing.rating} />
      </p>
    );
  }
  if (!open) {
    return (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Avaliar fornecedor
      </Button>
    );
  }
  return (
    <form
      className="w-full space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (rating) save.mutate({ supplierOrderId, rating, comment });
      }}
    >
      {save.isError && <Alert tone="error">{reviewErrorMessage(save.error)}</Alert>}
      <StarInput value={rating} onChange={setRating} />
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={2}
        maxLength={1000}
        placeholder="Como foi o envio, a embalagem e a qualidade? (opcional)"
        aria-label="Comentário"
        className="border-border bg-surface w-full rounded-lg border px-3 py-2 text-sm"
      />
      <div className="flex gap-2">
        <Button type="submit" disabled={!rating} loading={save.isPending}>
          Enviar avaliação
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
