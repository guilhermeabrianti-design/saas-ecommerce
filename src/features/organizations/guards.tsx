import { Navigate, Outlet } from 'react-router';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { useOrganization } from './organization-context';

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
