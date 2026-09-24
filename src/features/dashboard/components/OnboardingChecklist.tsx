import { Link } from 'react-router';
import { CircleCheck, Circle, ChevronRight } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { cn } from '@/utils/cn';
import { dashboardErrorMessage, useOnboarding } from '../api';
import { onboardingProgress, onboardingSteps } from '../dashboard';

/** Primeiros passos do vendedor. Cada passo vem marcado pelo banco; some quando tudo está feito. */
export function OnboardingChecklist({ orgId }: { orgId: string }) {
  const onboarding = useOnboarding(orgId);
  if (onboarding.isPending) return null;
  if (onboarding.isError) {
    return <Alert tone="error">{dashboardErrorMessage(onboarding.error)}</Alert>;
  }

  const progress = onboardingProgress(onboarding.data);
  if (progress.complete) return null;

  return (
    <section
      aria-labelledby="onboarding-title"
      className="border-border bg-surface rounded-xl border"
    >
      <div className="border-border space-y-3 border-b px-5 py-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="onboarding-title" className="text-sm font-semibold">
            Primeiros passos
          </h2>
          <span className="text-muted text-xs tabular-nums">
            {progress.done} de {progress.total} concluídos
          </span>
        </div>
        <ProgressBar percent={progress.percent} label="Primeiros passos concluídos" />
      </div>
      <ol className="divide-border divide-y">
        {onboarding.data.map((step) => {
          const info = onboardingSteps[step.key];
          const isNext = step.key === progress.next;
          return (
            <li key={step.key} className="flex items-center gap-3 px-5 py-3">
              {step.done ? (
                <CircleCheck className="text-success size-5 shrink-0" aria-label="Concluído" />
              ) : (
                <Circle className="text-muted size-5 shrink-0" aria-label="Pendente" />
              )}
              <div className="min-w-0 flex-1">
                <p className={cn('text-sm font-medium', step.done && 'text-muted line-through')}>
                  {info.label}
                </p>
                {!step.done && <p className="text-muted text-xs">{info.detail}</p>}
              </div>
              {!step.done && (
                <Link
                  to={info.to}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                    isNext
                      ? 'bg-brand text-brand-fg hover:bg-brand/90'
                      : 'text-brand hover:bg-brand/10',
                  )}
                >
                  {info.action}
                  <ChevronRight className="size-4" aria-hidden />
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
