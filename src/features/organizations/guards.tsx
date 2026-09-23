import { Navigate, Outlet } from 'react-router';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { useOrganization } from './organization-context';
import { orgKindLabels, type OrgKind } from './roles';

/** Tenant-scoped area: users without an organization are sent to create or join one. */
export function RequireOrganization() {
  const { isPending, isError, active } = useOrganization();

  if (isPending) return <PageLoader />;
  if (isError) {
    return (
      <Alert tone="error">Não foi possível carregar suas organizações. Recarregue a página.</Alert>
    );
  }
  if (!active) return <Navigate to="/organizacao/nova" replace />;
  return <Outlet />;
}

/** Area for one organization kind (e.g. the supplier catalog is for sellers). */
export function RequireOrgKind({ kind }: { kind: OrgKind }) {
  const { active } = useOrganization();
  if (active?.organization.kind !== kind) {
    return (
      <Alert tone="info">
        Esta área é exclusiva para organizações do tipo {orgKindLabels[kind].toLowerCase()}.
      </Alert>
    );
  }
  return <Outlet />;
}
