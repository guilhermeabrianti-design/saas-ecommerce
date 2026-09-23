import { cn } from '@/utils/cn';
import { connectionStatusLabels, type ConnectionStatus } from '../schemas';

const tone: Record<ConnectionStatus, string> = {
  active: 'bg-success/10 text-success',
  paused: 'bg-surface-2 text-muted',
  disconnected: 'bg-danger/10 text-danger',
};

export function ConnectionStatusBadge({ status }: { status: ConnectionStatus }) {
  return (
    <span
      className={cn('rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', tone[status])}
    >
      {connectionStatusLabels[status]}
    </span>
  );
}
