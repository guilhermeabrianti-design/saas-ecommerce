import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { orgKindLabels } from '@/features/organizations/roles';
import { cn } from '@/utils/cn';
import { SUPPORT_PAGE_SIZE, useAdminTickets, useSupportOverview, useTicketContext } from '../api';
import { Conversation } from '../components/Conversation';
import {
  dateTime,
  supportErrorMessage,
  ticketCategories,
  ticketCategoryLabels,
  ticketStatusLabel,
  ticketStatusTone,
  type TicketCategory,
} from '../support';

const statusFilters = [
  ['open', 'Aguardando a equipe'],
  ['waiting_user', 'Aguardando a pessoa'],
  ['closed', 'Encerrados'],
  ['all', 'Todos'],
] as const;

function Overview() {
  const o = useSupportOverview();
  if (o.isPending) return <PageLoader />;
  if (o.isError) return <Alert tone="error">{supportErrorMessage(o.error)}</Alert>;
  const tiles: [string, number][] = [
    ['Aguardando a equipe', o.data.open],
    ['Denúncias abertas', o.data.open_reports],
    ['Aguardando a pessoa', o.data.waiting_user],
    ['Encerrados (7 dias)', o.data.closed_7d],
  ];
  return (
    <dl className="grid gap-3 sm:grid-cols-4">
      {tiles.map(([label, value]) => (
        <div key={label} className="border-border bg-surface rounded-xl border p-4">
          <dt className="text-muted text-xs">{label}</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SupportAdminPage() {
  const [status, setStatus] = useState<string>('open');
  const [category, setCategory] = useState<TicketCategory | ''>('');
  const [page, setPage] = useState(1);
  const list = useAdminTickets(status, category, page);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Suporte e denúncias</h1>
        <p className="text-muted text-sm">Abertos mais antigos primeiro.</p>
      </div>
      <Overview />
      <div className="flex flex-wrap gap-3">
        <div className="w-56">
          <Select
            label="Estado"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            {statusFilters.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-56">
          <Select
            label="Categoria"
            value={category}
            onChange={(e) => {
              setCategory(e.target.value as TicketCategory | '');
              setPage(1);
            }}
          >
            <option value="">Todas</option>
            {ticketCategories.map((c) => (
              <option key={c} value={c}>
                {ticketCategoryLabels[c]}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {list.isPending ? (
        <PageLoader />
      ) : list.isError ? (
        <Alert tone="error">{supportErrorMessage(list.error)}</Alert>
      ) : list.data.length === 0 ? (
        <p className="text-muted text-sm">Nenhum chamado aqui.</p>
      ) : (
        <ul className="border-border bg-surface divide-border divide-y rounded-xl border">
          {list.data.map((t) => (
            <li key={t.id}>
              <Link
                to={`/admin/suporte/${t.id}`}
                className="hover:bg-surface-2 flex flex-wrap items-center justify-between gap-2 px-4 py-3"
              >
                <span>
                  <span className="block text-sm font-medium">
                    #{t.number} · {t.subject}
                  </span>
                  <span className="text-muted block text-xs">
                    {ticketCategoryLabels[t.category]} · {t.requester_name ?? '—'}
                    {t.organization_name && ` (${t.organization_name})`}
                    {t.reported_name && ` · denunciado: ${t.reported_name}`} · {t.messages}{' '}
                    mensagens · {dateTime(t.last_message_at)}
                  </span>
                </span>
                <span
                  className={cn(
                    'rounded px-2 py-0.5 text-xs font-medium',
                    ticketStatusTone[t.status],
                  )}
                >
                  {ticketStatusLabel(t.status, true)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {(page > 1 || list.data?.length === SUPPORT_PAGE_SIZE) && (
        <nav className="flex gap-2" aria-label="Paginação">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Anteriores
          </Button>
          <Button
            variant="secondary"
            disabled={list.data?.length !== SUPPORT_PAGE_SIZE}
            onClick={() => setPage(page + 1)}
          >
            Próximos
          </Button>
        </nav>
      )}
    </div>
  );
}

function ContextPanel({ ticketId }: { ticketId: string }) {
  const ctx = useTicketContext(ticketId);
  if (ctx.isPending || !ctx.data) return null;
  const c = ctx.data;
  const rows: [string, string | null][] = [
    ['Pessoa', [c.requester_name, c.requester_email].filter(Boolean).join(' · ') || null],
    [
      'Organização',
      c.organization_name
        ? `${c.organization_name}${c.organization_kind ? ` (${orgKindLabels[c.organization_kind]})` : ''}`
        : null,
    ],
    ['Pedido', c.order_number != null ? `#${c.order_number}` : null],
    [
      'Denunciado',
      c.reported_name
        ? `${c.reported_name}${c.reported_kind ? ` (${orgKindLabels[c.reported_kind]})` : ''}${c.reported_suspended ? ' — suspenso' : ''}`
        : null,
    ],
    ['Anúncio denunciado', c.reported_listing_name],
  ];
  return (
    <dl className="border-border bg-surface grid gap-2 rounded-xl border p-4 text-sm sm:grid-cols-2">
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k}>
            <dt className="text-muted text-xs">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

export function AdminTicketPage() {
  const { ticketId = '' } = useParams();
  return (
    <Conversation
      ticketId={ticketId}
      staff
      backTo="/admin/suporte"
      aside={<ContextPanel ticketId={ticketId} />}
    />
  );
}
