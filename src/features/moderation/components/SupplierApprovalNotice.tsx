import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { useOrganization } from '@/features/organizations/organization-context';
import { useRequestSupplierReview, useSupplierApproval } from '../api';
import { moderationErrorMessage } from '../moderation';

function RequestReview({ orgId }: { orgId: string }) {
  const request = useRequestSupplierReview(orgId);
  return (
    <>
      <Button variant="secondary" loading={request.isPending} onClick={() => request.mutate()}>
        Corrigi, pedir nova análise
      </Button>
      {request.isError && <p className="text-xs">{moderationErrorMessage(request.error)}</p>}
    </>
  );
}

/** Fornecedor em análise ou reprovado: explica por que os produtos não aparecem aos vendedores. */
export function SupplierApprovalNotice() {
  const { active } = useOrganization();
  const isSupplier = active?.organization.kind === 'supplier';
  const approval = useSupplierApproval(isSupplier ? active.organization.id : null);

  if (!isSupplier || !approval.data || approval.data.approval_status === 'approved') return null;

  if (approval.data.approval_status === 'pending') {
    return (
      <Alert tone="info" className="mb-6">
        <p className="font-medium">Cadastro de fornecedor em análise.</p>
        <p>
          Você já pode cadastrar produtos e preparar o catálogo. Eles passam a aparecer para os
          vendedores depois que a equipe TheSigns aprovar a sua empresa e cada anúncio.
        </p>
      </Alert>
    );
  }
  return (
    <Alert tone="error" className="mb-6">
      <p className="font-medium">Cadastro de fornecedor reprovado.</p>
      {approval.data.approval_reason && <p>Motivo: {approval.data.approval_reason}</p>}
      <p>Seus produtos não aparecem para os vendedores até a aprovação.</p>
      {active.role === 'owner' ? (
        <RequestReview orgId={active.organization.id} />
      ) : (
        <p>Somente o proprietário pode pedir nova análise.</p>
      )}
    </Alert>
  );
}
