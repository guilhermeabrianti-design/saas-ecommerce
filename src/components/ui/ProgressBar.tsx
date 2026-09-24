import { cn } from '@/utils/cn';

export function ProgressBar({
  percent,
  label,
  className,
}: {
  percent: number;
  label: string;
  className?: string;
}) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn('bg-surface-2 h-2 overflow-hidden rounded-full', className)}
    >
      <div
        className={cn('h-full rounded-full', value === 100 ? 'bg-success' : 'bg-brand')}
        style={{ width: `${value}%` }}
      />
    </div>
  );
}
