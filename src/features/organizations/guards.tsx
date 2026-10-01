import { Outlet } from 'react-router';
import { useMySuspendedOrganizations } from '@/features/admin/api';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { EnsureOrganization } from './components/EnsureOrganization';
import { useOrganization } from './organization-context';
import { orgKindLabels, type OrgKind } from './roles';

/** Área da organização: quem ainda não tem uma ganha a sua na hora (sem formulário). */
export function RequireOrganization() {
  const { isPending, isError, active } = useOrganization();
  const suspended = useMySuspendedOrganizations();

  if (isPending) return <PageLoader />;
  if (isError) {
    return (
      <Alert tone="error">Não foi possível carregar suas empresas. Recarregue a página.</Alert>
    );
  }
  if (!active) {
    if (suspended.isPending) return <PageLoader />;
    // Sem organização ativa por causa de suspensão: o aviso (no layout) explica; não crie outra.
    if ((suspended.data?.length ?? 0) > 0) return null;
    return <EnsureOrganization />;
  }
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
