import { env } from '@/lib/env';
import { cn } from '@/utils/cn';

const styles = {
  development: 'bg-brand/10 text-brand',
  staging: 'bg-warning/15 text-warning',
  production: 'hidden',
} as const;

export function EnvBadge() {
  return (
    <span
      className={cn(
        'rounded-md px-2 py-1 font-mono text-xs font-medium uppercase',
        styles[env.appEnv],
      )}
    >
      {env.appEnv}
    </span>
  );
}
