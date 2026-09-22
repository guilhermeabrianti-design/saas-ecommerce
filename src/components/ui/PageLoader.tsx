import { Loader2 } from 'lucide-react';

export function PageLoader({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div
      role="status"
      className="text-muted flex min-h-48 items-center justify-center gap-2 text-sm"
    >
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}
