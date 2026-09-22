import { useId, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';
import { cn } from '@/utils/cn';

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

export function TextField({ label, error, hint, id, className, ref, ...props }: TextFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const descId = `${inputId}-desc`;
  const hasDesc = Boolean(error || hint);

  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-sm font-medium">
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={hasDesc ? descId : undefined}
        className={cn(
          'border-border bg-surface placeholder:text-muted/70 focus:border-brand focus:ring-brand/30 h-10 w-full rounded-lg border px-3 text-sm transition-colors outline-none focus:ring-2 disabled:opacity-60',
          error && 'border-danger focus:border-danger focus:ring-danger/30',
          className,
        )}
        {...props}
      />
      {hasDesc && (
        <div id={descId} className={cn('text-xs', error ? 'text-danger' : 'text-muted')}>
          {error ?? hint}
        </div>
      )}
    </div>
  );
}
