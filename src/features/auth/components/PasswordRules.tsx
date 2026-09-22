import { Check, Circle } from 'lucide-react';
import { cn } from '@/utils/cn';
import { passwordRules } from '../schemas';

/** Live checklist of the password policy. */
export function PasswordRules({ value }: { value: string }) {
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-1">
      {passwordRules.map((rule) => {
        const ok = rule.test(value);
        const Icon = ok ? Check : Circle;
        return (
          <li key={rule.label} className={cn('flex items-center gap-1.5', ok && 'text-success')}>
            <Icon className="size-3" aria-hidden />
            <span>
              {rule.label}
              <span className="sr-only">{ok ? ' — atendido' : ' — pendente'}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
