import { Alert } from '@/components/ui/Alert';
import type { SuspendedOrganization } from '../api';

/** Explica por que uma organização sumiu: suspensa pela equipe, com o motivo registrado. */
export function SuspensionNotice({ organizations }: { organizations: SuspendedOrganization[] }) {
  if (organizations.length === 0) return null;
  return (
    <div className="mb-6 space-y-2">
      {organizations.map((o) => (
        <Alert key={o.id} tone="error">
          <p className="font-medium">A organização “{o.name}” está suspensa.</p>
          <p>
            {o.reason ? `Motivo: ${o.reason}. ` : ''}Enquanto durar a suspensão, o acesso aos dados
            fica bloqueado. Entre em contato com o suporte da TheSigns para regularizar.
          </p>
        </Alert>
      ))}
    </div>
  );
}
