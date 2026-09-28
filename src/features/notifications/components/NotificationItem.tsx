import { Link } from 'react-router';
import { cn } from '@/utils/cn';
import { kindStyle, relativeTime, safeLink, toneClass, type Notification } from '../notifications';

/** Uma notificação; ao abrir o link, marca como lida. */
export function NotificationItem({
  n,
  onOpen,
  showOrg,
}: {
  n: Notification;
  onOpen: (n: Notification) => void;
  showOrg: boolean;
}) {
  const { icon: Icon, tone } = kindStyle(n.kind);
  const link = safeLink(n.link);
  const unread = n.read_at == null;
  const content = (
    <>
      <span
        className={cn(
          'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full',
          toneClass[tone],
        )}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-sm', unread ? 'font-semibold' : 'font-medium')}>
          {n.title}
        </span>
        {n.body && <span className="text-muted block text-xs">{n.body}</span>}
        <span className="text-muted mt-0.5 block text-xs">
          {relativeTime(n.created_at)}
          {showOrg && n.organizations?.name && ` · ${n.organizations.name}`}
        </span>
      </span>
      {unread && (
        <span className="bg-brand mt-2 size-2 shrink-0 rounded-full" aria-label="Não lida" />
      )}
    </>
  );
  const className = cn(
    'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2',
    unread && 'bg-brand/5',
  );
  return link ? (
    <Link to={link} className={className} onClick={() => onOpen(n)}>
      {content}
    </Link>
  ) : (
    <button type="button" className={className} onClick={() => onOpen(n)}>
      {content}
    </button>
  );
}
