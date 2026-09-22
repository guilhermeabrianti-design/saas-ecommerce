import { useNavigate } from 'react-router';
import { MailOpen } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { useAcceptInvitation, useDeclineInvitation, useMyInvitations } from '../api';
import { orgErrorMessage } from '../errors';
import { useOrganization } from '../organization-context';
import { orgKindLabels, orgRoleLabels } from '../roles';

/** Invitations addressed to the signed-in user. Renders nothing when there are none. */
export function PendingInvitations() {
  const invitations = useMyInvitations();
  const accept = useAcceptInvitation();
  const decline = useDeclineInvitation();
  const { selectOrganization } = useOrganization();
  const navigate = useNavigate();

  if (!invitations.data?.length) return null;
  const error = accept.error ?? decline.error;
  const busyId = accept.isPending ? accept.variables : decline.isPending ? decline.variables : null;

  return (
    <section aria-labelledby="pending-invitations" className="space-y-3">
      <h2 id="pending-invitations" className="text-sm font-semibold">
        Convites pendentes
      </h2>
      {error && <Alert tone="error">{orgErrorMessage(error)}</Alert>}
      <ul className="space-y-2">
        {invitations.data.map((inv) => (
          <li
            key={inv.id}
            className="border-border bg-surface flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3"
          >
            <MailOpen className="text-brand size-5 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1 text-sm">
              <p className="truncate font-medium">{inv.organization_name}</p>
              <p className="text-muted">
                {orgKindLabels[inv.organization_kind]} · entrar como {orgRoleLabels[inv.role]}
                {inv.invited_by_name && ` · convite de ${inv.invited_by_name}`}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                loading={accept.isPending && busyId === inv.id}
                disabled={busyId !== null}
                onClick={() =>
                  accept.mutate(inv.id, {
                    onSuccess: (orgId) => {
                      selectOrganization(orgId);
                      void navigate('/');
                    },
                  })
                }
              >
                Aceitar
              </Button>
              <Button
                variant="ghost"
                loading={decline.isPending && busyId === inv.id}
                disabled={busyId !== null}
                onClick={() => decline.mutate(inv.id)}
              >
                Recusar
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
