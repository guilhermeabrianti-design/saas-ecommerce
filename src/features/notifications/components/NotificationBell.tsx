import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Bell } from 'lucide-react';
import { useAuth } from '@/features/auth/auth-context';
import { useOrganization } from '@/features/organizations/organization-context';
import {
  useMarkAllRead,
  useMarkRead,
  useNotifications,
  useNotificationsRealtime,
  useUnreadCount,
} from '../api';
import { badgeText, type Notification } from '../notifications';
import { NotificationItem } from './NotificationItem';

/** Sino do cabeçalho: contador de não lidas, últimas 10 e atualização em tempo real. */
export function NotificationBell() {
  const { user } = useAuth();
  const { memberships } = useOrganization();
  useNotificationsRealtime(user?.id ?? null);
  const unread = useUnreadCount();
  const [open, setOpen] = useState(false);
  const list = useNotifications('all', 10);
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const count = unread.data ?? 0;
  const onOpen = (n: Notification) => {
    if (!n.read_at) markRead.mutate([n.id]);
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={count ? `Notificações: ${count} não lidas` : 'Notificações'}
        className="border-border text-muted hover:bg-surface-2 hover:text-fg relative inline-flex size-9 items-center justify-center rounded-lg border transition-colors"
      >
        <Bell className="size-4" aria-hidden />
        {count > 0 && (
          <span className="bg-danger absolute -top-1.5 -right-1.5 min-w-5 rounded-full px-1 text-center text-[10px] leading-5 font-semibold text-white">
            {badgeText(count)}
          </span>
        )}
      </button>

      {open && (
        <div className="border-border bg-surface absolute right-0 z-50 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border shadow-lg">
          <div className="border-border flex items-center justify-between border-b px-4 py-3">
            <p className="text-sm font-semibold">Notificações</p>
            {count > 0 && (
              <button
                type="button"
                className="text-brand text-xs font-medium hover:underline"
                onClick={() => markAll.mutate()}
              >
                Marcar todas como lidas
              </button>
            )}
          </div>
          <div className="divide-border max-h-96 divide-y overflow-y-auto">
            {list.isPending ? (
              <p className="text-muted px-4 py-6 text-center text-sm">Carregando…</p>
            ) : list.isError ? (
              <p className="text-danger px-4 py-6 text-center text-sm">
                Não foi possível carregar.
              </p>
            ) : list.data.length === 0 ? (
              <p className="text-muted px-4 py-6 text-center text-sm">Nenhuma notificação.</p>
            ) : (
              list.data.map((n) => (
                <NotificationItem
                  key={n.id}
                  n={n}
                  onOpen={onOpen}
                  showOrg={memberships.length > 1}
                />
              ))
            )}
          </div>
          <Link
            to="/notificacoes"
            onClick={() => setOpen(false)}
            className="border-border text-brand block border-t px-4 py-2.5 text-center text-sm font-medium hover:underline"
          >
            Ver todas
          </Link>
        </div>
      )}
    </div>
  );
}
