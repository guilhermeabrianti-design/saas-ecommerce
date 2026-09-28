import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { useAuth } from '@/features/auth/auth-context';
import { useOrganization } from '@/features/organizations/organization-context';
import { cn } from '@/utils/cn';
import { useCreateTicket, useMyTickets } from '../api';
import { Conversation } from '../components/Conversation';
import {
  dateTime,
  newTicketSchema,
  supportErrorMessage,
  ticketCategories,
  ticketCategoryLabels,
  ticketPrefill,
  ticketStatusLabel,
  ticketStatusTone,
  type NewTicketValues,
} from '../support';

function NewTicketForm() {
  const [params] = useSearchParams();
  const prefill = ticketPrefill(params);
  const { active } = useOrganization();
  const navigate = useNavigate();
  const create = useCreateTicket();
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<NewTicketValues>({
    resolver: zodResolver(newTicketSchema(prefill.listingId !== null)),
    defaultValues: {
      category: prefill.category,
      subject: '',
      body: '',
      reported_code: '',
    },
  });
  const category = useWatch({ control, name: 'category' });

  const onSubmit = handleSubmit((v) =>
    create.mutate(
      {
        orgId: active?.organization.id ?? null,
        category: v.category,
        subject: v.subject,
        body: v.body,
        orderId: prefill.orderId,
        listingId: v.category === 'report' ? prefill.listingId : null,
        reportedCode: v.category === 'report' ? v.reported_code : null,
      },
      { onSuccess: (id) => void navigate(`/suporte/${id}`) },
    ),
  );

  return (
    <Section
      title="Abrir chamado"
      description="Conte o que aconteceu. A equipe responde por aqui e você é avisado nas notificações."
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {create.isError && <Alert tone="error">{supportErrorMessage(create.error)}</Alert>}
        {prefill.orderId && <Alert tone="info">O pedido será anexado ao chamado.</Alert>}
        {prefill.listingId && category === 'report' && (
          <Alert tone="info">O anúncio denunciado será anexado ao chamado.</Alert>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Assunto" {...register('category')}>
            {ticketCategories.map((c) => (
              <option key={c} value={c}>
                {ticketCategoryLabels[c]}
              </option>
            ))}
          </Select>
          <TextField label="Resumo" error={errors.subject?.message} {...register('subject')} />
        </div>
        {category === 'report' && !prefill.listingId && (
          <TextField
            label="Código da loja ou fornecedor denunciado"
            hint="Aparece no endereço da vitrine: /loja/<código>"
            autoComplete="off"
            error={errors.reported_code?.message}
            {...register('reported_code')}
          />
        )}
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Mensagem</span>
          <textarea
            rows={5}
            maxLength={5000}
            aria-invalid={errors.body ? true : undefined}
            className="border-border bg-surface focus-visible:ring-brand/50 w-full rounded-lg border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
            {...register('body')}
          />
          {errors.body && <span className="text-danger text-xs">{errors.body.message}</span>}
        </label>
        <Button type="submit" loading={create.isPending}>
          Enviar chamado
        </Button>
      </form>
    </Section>
  );
}

function MyTickets({ userId }: { userId: string }) {
  const tickets = useMyTickets(userId);
  if (tickets.isPending) return <PageLoader />;
  if (tickets.isError) return <Alert tone="error">{supportErrorMessage(tickets.error)}</Alert>;
  if (!tickets.data.length) return <p className="text-muted text-sm">Nenhum chamado ainda.</p>;
  return (
    <ul className="border-border bg-surface divide-border divide-y rounded-xl border">
      {tickets.data.map((t) => (
        <li key={t.id}>
          <Link
            to={`/suporte/${t.id}`}
            className="hover:bg-surface-2 flex flex-wrap items-center justify-between gap-2 px-4 py-3"
          >
            <span>
              <span className="block text-sm font-medium">
                #{t.number} · {t.subject}
              </span>
              <span className="text-muted block text-xs">
                {ticketCategoryLabels[t.category]} · {dateTime(t.last_message_at)}
              </span>
            </span>
            <span
              className={cn('rounded px-2 py-0.5 text-xs font-medium', ticketStatusTone[t.status])}
            >
              {ticketStatusLabel(t.status, false)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function SupportPage() {
  const { user } = useAuth();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Suporte</h1>
        <p className="text-muted text-sm">
          Dúvidas, problemas com pedidos e pagamentos, e denúncias de produtos ou lojas.
        </p>
      </div>
      <NewTicketForm />
      <Section title="Meus chamados" description="Mais recentes primeiro.">
        {user && <MyTickets userId={user.id} />}
      </Section>
    </div>
  );
}

export function TicketPage() {
  const { ticketId = '' } = useParams();
  return <Conversation ticketId={ticketId} staff={false} backTo="/suporte" />;
}
