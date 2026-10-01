import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { clearReferralCode, pendingReferralCode } from '@/features/affiliates/affiliates';
import { getSupabase } from '@/lib/supabase';
import { orgErrorMessage } from '../errors';
import { clearInviteToken, inviteErrorMessage, pendingInviteToken } from '../invite';
import { useOrganization } from '../organization-context';

class InviteFailed extends Error {
  constructor(readonly original: unknown) {
    super('invite_failed');
  }
}

/**
 * Conta sem empresa: entra na do link de convite guardado ou, sem convite,
 * ganha a sua na hora (tipo da conta, nome provisório renomeável). Nada de
 * formulário. O banco é idempotente: chamadas repetidas devolvem a mesma.
 */
export function EnsureOrganization() {
  const { selectOrganization } = useOrganization();
  const queryClient = useQueryClient();
  const started = useRef(false);
  const [skipInvite, setSkipInvite] = useState(false);

  const ensure = useMutation({
    mutationFn: async (ignoreInvite: boolean) => {
      const supabase = getSupabase();
      const token = ignoreInvite ? null : pendingInviteToken();
      if (token) {
        const { data, error } = await supabase.rpc('accept_invite_link', { p_token: token });
        if (error) throw new InviteFailed(error);
        clearInviteToken();
        return z.uuid().parse(data);
      }
      const { data, error } = await supabase.rpc('ensure_my_organization', {
        p_referral_code: pendingReferralCode(),
      });
      if (error) throw error;
      clearReferralCode();
      return z.uuid().parse(data);
    },
    onSuccess: async (orgId) => {
      selectOrganization(orgId);
      await queryClient.invalidateQueries({ queryKey: ['memberships'] });
    },
  });

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    ensure.mutate(false);
  }, [ensure]);

  if (ensure.error instanceof InviteFailed && !skipInvite) {
    return (
      <div className="mx-auto max-w-md space-y-3">
        <Alert tone="error">{inviteErrorMessage(ensure.error.original)}</Alert>
        <Button
          variant="secondary"
          onClick={() => {
            clearInviteToken();
            setSkipInvite(true);
            ensure.mutate(true);
          }}
        >
          Continuar sem o convite (minha própria empresa)
        </Button>
      </div>
    );
  }
  if (ensure.isError && !(ensure.error instanceof InviteFailed)) {
    return (
      <div className="mx-auto max-w-md space-y-3">
        <Alert tone="error">
          Não foi possível preparar sua empresa. {orgErrorMessage(ensure.error)}
        </Alert>
        <Button onClick={() => ensure.mutate(skipInvite)} loading={ensure.isPending}>
          Tentar de novo
        </Button>
      </div>
    );
  }
  return <PageLoader />;
}
