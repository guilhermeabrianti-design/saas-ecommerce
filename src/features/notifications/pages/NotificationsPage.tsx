import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { useOrganization } from '@/features/organizations/organization-context';
import { cn } from '@/utils/cn';
import { NOTIFICATIONS_PAGE_SIZE, useMarkAllRead, useMarkRead, useNotifications } from '../api';
import { NotificationItem } from '../components/NotificationItem';
import type { Notification } from '../notifications';

export function NotificationsPage() {
  const { memberships } = useOrganization();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [limit, setLimit] = useState(NOTIFICATIONS_PAGE_SIZE);
  const list = useNotifications(filter, limit);
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();

  const onOpen = (n: Notification) => {
    if (!n.read_at) markRead.mutate([n.id]);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notificações</h1>
          <p className="text-muted text-sm">
            Estoque, catálogo, pedidos, pagamentos e carteira. Chegam em tempo real e ficam
            guardadas por 90 dias.
          </p>
        </div>
        <Button variant="secondary" loading={markAll.isPending} onClick={() => markAll.mutate()}>
          Marcar todas como lidas
        </Button>
      </div>

      <div className="flex gap-2" role="tablist" aria-label="Filtro">
        {(
          [
            ['all', 'Todas'],
            ['unread', 'Não lidas'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filter === value}
            onClick={() => {
              setFilter(value);
              setLimit(NOTIFICATIONS_PAGE_SIZE);
            }}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-medium',
              filter === value ? 'bg-brand/10 text-brand' : 'text-muted hover:bg-surface-2',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {list.isPending ? (
        <PageLoader />
      ) : list.isError ? (
        <Alert tone="error">Não foi possível carregar as notificações. Tente de novo.</Alert>
      ) : list.data.length === 0 ? (
        <p className="text-muted text-sm">
          {filter === 'unread' ? 'Tudo lido por aqui.' : 'Nenhuma notificação ainda.'}
        </p>
      ) : (
        <>
          <div className="border-border bg-surface divide-border divide-y overflow-hidden rounded-xl border">
            {list.data.map((n) => (
              <NotificationItem key={n.id} n={n} onOpen={onOpen} showOrg={memberships.length > 1} />
            ))}
          </div>
          {list.data.length === limit && (
            <Button
              variant="secondary"
              onClick={() => setLimit((l) => l + NOTIFICATIONS_PAGE_SIZE)}
            >
              Carregar mais
            </Button>
          )}
        </>
      )}
    </div>
  );
}
