import { useState, type ReactNode } from 'react';
import { Button } from './Button';

/** Destructive action that asks for a second click before running. */
export function ConfirmButton({
  children,
  confirmLabel = 'Confirmar',
  onConfirm,
  loading,
  className,
}: {
  children: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  loading?: boolean;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <Button variant="secondary" className={className} onClick={() => setAsking(true)}>
        {children}
      </Button>
    );
  }
  return (
    <span className="inline-flex gap-2">
      <Button variant="danger" loading={loading} onClick={onConfirm}>
        {confirmLabel}
      </Button>
      <Button variant="ghost" onClick={() => setAsking(false)}>
        Cancelar
      </Button>
    </span>
  );
}
