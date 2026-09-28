import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { orgKindLabels } from '@/features/organizations/roles';
import { useAdminReviews, useSetReviewHidden } from '../api';
import { Stars } from '../components/Stars';
import { reviewErrorMessage, type AdminReview } from '../reviews';

const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

function Moderate({ r }: { r: AdminReview }) {
  const set = useSetReviewHidden();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  if (r.hidden_at) {
    return (
      <Button
        variant="secondary"
        loading={set.isPending}
        onClick={() => set.mutate({ id: r.id, hidden: false, reason: null })}
      >
        Reexibir
      </Button>
    );
  }
  if (!asking) {
    return (
      <Button variant="secondary" onClick={() => setAsking(true)}>
        Ocultar
      </Button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        set.mutate(
          { id: r.id, hidden: true, reason: reason.trim() },
          { onSuccess: () => setAsking(false) },
        );
      }}
    >
      <div className="w-64">
        <TextField
          label="Motivo"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={set.isError ? reviewErrorMessage(set.error) : undefined}
        />
      </div>
      <Button type="submit" variant="danger" loading={set.isPending}>
        Ocultar
      </Button>
      <Button variant="ghost" onClick={() => setAsking(false)}>
        Cancelar
      </Button>
    </form>
  );
}

export function ReviewsAdminPage() {
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const list = useAdminReviews(filter, page);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Avaliações</h1>
        <p className="text-muted text-sm">
          Oculte avaliações ofensivas ou fora do assunto. Ocultas saem da média; tudo fica na
          auditoria.
        </p>
      </div>
      <div className="w-56">
        <Select
          label="Mostrar"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="all">Todas</option>
          <option value="low">1 ou 2 estrelas</option>
          <option value="hidden">Ocultas</option>
        </Select>
      </div>
      {list.isPending ? (
        <PageLoader />
      ) : list.isError ? (
        <Alert tone="error">{reviewErrorMessage(list.error)}</Alert>
      ) : list.data.length === 0 ? (
        <p className="text-muted text-sm">Nenhuma avaliação aqui.</p>
      ) : (
        <ul className="border-border bg-surface divide-border divide-y rounded-xl border">
          {list.data.map((r) => (
            <li key={r.id} className="space-y-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Stars value={r.rating} />
                <span className="font-medium">
                  {r.target_name} ({orgKindLabels[r.target_kind]})
                </span>
                <span className="text-muted">
                  · por {r.reviewer_org_name ?? r.reviewer_label} · {day(r.created_at)}
                </span>
              </div>
              {r.comment && <p className="text-sm">{r.comment}</p>}
              {r.reply && <p className="text-muted text-sm">Resposta: {r.reply}</p>}
              {r.hidden_reason && <p className="text-danger text-xs">Oculta: {r.hidden_reason}</p>}
              <Moderate r={r} />
            </li>
          ))}
        </ul>
      )}
      {(page > 1 || list.data?.length === 50) && (
        <nav className="flex gap-2" aria-label="Paginação">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Mais recentes
          </Button>
          <Button
            variant="secondary"
            disabled={list.data?.length !== 50}
            onClick={() => setPage(page + 1)}
          >
            Mais antigas
          </Button>
        </nav>
      )}
    </div>
  );
}
