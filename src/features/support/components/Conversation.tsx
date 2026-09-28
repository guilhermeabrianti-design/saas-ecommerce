import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { cn } from '@/utils/cn';
import { useCloseTicket, useReplyTicket, useTicket } from '../api';
import {
  dateTime,
  supportErrorMessage,
  ticketCategoryLabels,
  ticketStatusLabel,
  ticketStatusTone,
} from '../support';

function ReplyForm({ ticketId, closed }: { ticketId: string; closed: boolean }) {
  const reply = useReplyTicket(ticketId);
  const [body, setBody] = useState('');
  const text = body.trim();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (text) reply.mutate(text, { onSuccess: () => setBody('') });
      }}
    >
      {reply.isError && <Alert tone="error">{supportErrorMessage(reply.error)}</Alert>}
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">
          {closed ? 'Reabrir com uma mensagem' : 'Responder'}
        </span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          maxLength={5000}
          className="border-border bg-surface focus-visible:ring-brand/50 w-full rounded-lg border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
      </label>
      <Button type="submit" disabled={!text} loading={reply.isPending}>
        Enviar
      </Button>
    </form>
  );
}

/** Conversa de um chamado: usada por quem abriu (`staff=false`) e pela equipe. */
export function Conversation({
  ticketId,
  staff,
  backTo,
  aside,
}: {
  ticketId: string;
  staff: boolean;
  backTo: string;
  aside?: React.ReactNode;
}) {
  const query = useTicket(ticketId);
  const close = useCloseTicket(ticketId);

  if (query.isPending) return <PageLoader />;
  if (query.isError) return <Alert tone="error">{supportErrorMessage(query.error)}</Alert>;
  if (!query.data) return <Alert tone="info">Chamado não encontrado.</Alert>;
  const { ticket, messages } = query.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link to={backTo} className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm">
        <ArrowLeft className="size-4" aria-hidden />
        Voltar
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-muted text-sm">
            Chamado #{ticket.number} · {ticketCategoryLabels[ticket.category]}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{ticket.subject}</h1>
        </div>
        <span
          className={cn('rounded px-2 py-1 text-xs font-medium', ticketStatusTone[ticket.status])}
        >
          {ticketStatusLabel(ticket.status, staff)}
        </span>
      </div>

      {aside}

      <ol className="space-y-3" aria-label="Mensagens">
        {messages.map((m) => {
          const mine = staff ? m.from_staff : !m.from_staff;
          return (
            <li
              key={m.id}
              className={cn(
                'max-w-[85%] rounded-xl border px-4 py-3',
                mine ? 'border-brand/30 bg-brand/5 ml-auto' : 'border-border bg-surface',
              )}
            >
              <p className="text-muted mb-1 text-xs">
                {m.from_staff ? 'Equipe TheSigns' : staff ? 'Pessoa' : 'Você'} ·{' '}
                {dateTime(m.created_at)}
              </p>
              <p className="text-sm whitespace-pre-line">{m.body}</p>
            </li>
          );
        })}
      </ol>

      <ReplyForm ticketId={ticket.id} closed={ticket.status === 'closed'} />

      {ticket.status !== 'closed' && (
        <div>
          {close.isError && <Alert tone="error">{supportErrorMessage(close.error)}</Alert>}
          <Button variant="ghost" loading={close.isPending} onClick={() => close.mutate()}>
            {staff ? 'Encerrar chamado' : 'Resolvido, encerrar chamado'}
          </Button>
        </div>
      )}
    </div>
  );
}
