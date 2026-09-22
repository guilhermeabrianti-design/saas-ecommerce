import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import { cn } from '@/utils/cn';

type Tone = 'error' | 'success' | 'info';

const tones: Record<Tone, { className: string; icon: typeof Info }> = {
  error: { className: 'border-danger/30 bg-danger/10 text-danger', icon: CircleAlert },
  success: { className: 'border-success/30 bg-success/10 text-success', icon: CircleCheck },
  info: { className: 'border-brand/30 bg-brand/10 text-brand', icon: Info },
};

export function Alert({
  tone = 'info',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  const { className: toneClass, icon: Icon } = tones[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('flex gap-2.5 rounded-lg border px-3.5 py-3 text-sm', toneClass, className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-2">{children}</div>
    </div>
  );
}
