import { useId, type Ref, type SelectHTMLAttributes } from 'react';
import { cn } from '@/utils/cn';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Visible label. Without it, pass `aria-label`. */
  label?: string;
  ref?: Ref<HTMLSelectElement>;
}

export function Select({ label, id, className, ref, children, ...props }: SelectProps) {
  const autoId = useId();
  const selectId = id ?? autoId;

  const select = (
    <select
      ref={ref}
      id={selectId}
      className={cn(
        'border-border bg-surface focus:border-brand focus:ring-brand/30 h-10 rounded-lg border px-3 text-sm transition-colors outline-none focus:ring-2 disabled:opacity-60',
        label && 'w-full',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );

  if (!label) return select;
  return (
    <div className="space-y-1.5">
      <label htmlFor={selectId} className="block text-sm font-medium">
        {label}
      </label>
      {select}
    </div>
  );
}
