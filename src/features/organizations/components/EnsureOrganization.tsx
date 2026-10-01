import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { clearReferralCode, pendingReferralCode } from '@/features/affiliates/affiliates';
import { getSupabase } from '@/lib/supabase';
import { orgErrorMessage } from '../errors';
import { useOrganization } from '../organization-context';

/**
 * Conta sem organização: cria a dela na hora (tipo da conta, nome
 * provisório renomeável em Organização) em vez de mandar para um
 * formulário. O banco é idempotente: chamadas repetidas devolvem a mesma.
 */
export function EnsureOrganization() {
  const { selectOrganization } = useOrganization();
  const queryClient = useQueryClient();
  const started = useRef(false);
  const ensure = useMutation({
    mutationFn: async () => {
      const { data, error } = await getSupabase().rpc('ensure_my_organization', {
        p_referral_code: pendingReferralCode(),
      });
      if (error) throw error;
      return z.uuid().parse(data);
    },
    onSuccess: async (orgId) => {
      clearReferralCode();
      selectOrganization(orgId);
      await queryClient.invalidateQueries({ queryKey: ['memberships'] });
    },
  });

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    ensure.mutate();
  }, [ensure]);

  if (ensure.isError) {
    return (
      <div className="mx-auto max-w-md space-y-3">
        <Alert tone="error">
          Não foi possível preparar sua organização. {orgErrorMessage(ensure.error)}
        </Alert>
        <Button onClick={() => ensure.mutate()} loading={ensure.isPending}>
          Tentar de novo
        </Button>
      </div>
    );
  }
  return <PageLoader />;
}
