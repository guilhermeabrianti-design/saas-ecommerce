import { cn } from '@/utils/cn';

export type StatusTone = 'ok' | 'warn' | 'error' | 'idle';

const tones: Record<StatusTone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  error: 'bg-danger',
  idle: 'bg-muted',
};

export function StatusDot({ tone, className }: { tone: StatusTone; className?: string }) {
  return (
    <span className={cn('inline-block size-2 shrink-0 rounded-full', tones[tone], className)} />
  );
}
