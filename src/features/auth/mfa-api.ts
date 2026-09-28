import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSupabase } from '@/lib/supabase';

export const mfaKeys = { factors: ['mfa-factors'] as const };

export interface TotpFactor {
  id: string;
  friendly_name?: string;
  status: 'verified' | 'unverified';
  created_at: string;
}

export function useTotpFactors() {
  return useQuery({
    queryKey: mfaKeys.factors,
    queryFn: async () => {
      const { data, error } = await getSupabase().auth.mfa.listFactors();
      if (error) throw error;
      return (data.all ?? []).filter((f) => f.factor_type === 'totp') as TotpFactor[];
    },
  });
}

export interface Enrollment {
  factorId: string;
  qrCode: string;
  secret: string;
}

/** Novo aplicativo autenticador (descarta tentativas não confirmadas antes). */
export function useEnrollTotp() {
  return useMutation({
    mutationFn: async (): Promise<Enrollment> => {
      const auth = getSupabase().auth;
      const listed = await auth.mfa.listFactors();
      if (listed.error) throw listed.error;
      for (const f of listed.data.all ?? []) {
        if (f.factor_type === 'totp' && f.status === 'unverified') {
          await auth.mfa.unenroll({ factorId: f.id });
        }
      }
      const { data, error } = await auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: `Autenticador ${new Date().toLocaleDateString('pt-BR')} ${Date.now() % 10000}`,
      });
      if (error) throw error;
      return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
    },
  });
}

/** Confere o código: a sessão passa a aal2 (o AuthProvider recebe a nova sessão). */
export function useVerifyTotp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ factorId, code }: { factorId: string; code: string }) => {
      const { error } = await getSupabase().auth.mfa.challengeAndVerify({ factorId, code });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

export function useUnenrollTotp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (factorId: string) => {
      const auth = getSupabase().auth;
      const { error } = await auth.mfa.unenroll({ factorId });
      if (error) throw error;
      // Sem fator verificado a sessão volta a aal1.
      await auth.refreshSession();
    },
    onSuccess: () => queryClient.invalidateQueries(),
  });
}
