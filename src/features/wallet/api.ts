import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { financeKeys } from '@/features/finance/api';
import { orgKinds } from '@/features/organizations/roles';
import { getSupabase } from '@/lib/supabase';
import { onlyDigits } from '@/utils/br';
import { parseBRL } from '@/utils/money';
import {
  pendingCreditSchema,
  pixKeyTypes,
  walletSummarySchema,
  withdrawalSchema,
  withdrawalStatuses,
  type WithdrawalFormValues,
} from './wallet';

export const WITHDRAWALS_PAGE_SIZE = 50;

export const walletKeys = {
  all: (orgId: string) => ['wallet', orgId] as const,
  summary: (orgId: string) => ['wallet', orgId, 'summary'] as const,
  pending: (orgId: string) => ['wallet', orgId, 'pending'] as const,
  withdrawals: (orgId: string) => ['wallet', orgId, 'withdrawals'] as const,
  admin: ['wallet-admin'] as const,
  adminOverview: ['wallet-admin', 'overview'] as const,
  adminList: (status: string, page: number) => ['wallet-admin', 'list', status, page] as const,
  settings: ['wallet-settings'] as const,
};

// ---------------------------------------------------------------------
// Organização
// ---------------------------------------------------------------------

export function useWalletSummary(orgId: string) {
  return useQuery({
    queryKey: walletKeys.summary(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('wallet_summary', { p_org: orgId });
      if (error) throw error;
      return walletSummarySchema.parse(data);
    },
  });
}

export function useWalletPending(orgId: string) {
  return useQuery({
    queryKey: walletKeys.pending(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('wallet_pending', { p_org: orgId });
      if (error) throw error;
      return z.array(pendingCreditSchema).parse(data);
    },
  });
}

export function useWithdrawals(orgId: string) {
  return useQuery({
    queryKey: walletKeys.withdrawals(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('withdrawal_requests')
        .select(
          'id, amount_cents, status, pix_key_type, pix_key, holder_name, rejection_reason, payout_reference, created_at, paid_at',
        )
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return z.array(withdrawalSchema).parse(data);
    },
  });
}

function invalidateOrg(queryClient: ReturnType<typeof useQueryClient>, orgId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: walletKeys.all(orgId) }),
    queryClient.invalidateQueries({ queryKey: financeKeys.all(orgId) }),
  ]);
}

/** Solicita um saque; `requestId` torna a repetição inofensiva. */
export function useRequestWithdrawal(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      values,
      requestId,
    }: {
      values: WithdrawalFormValues;
      requestId: string;
    }) => {
      const cents = parseBRL(values.amount);
      if (cents === null || cents < 1) throw new Error('wallet.invalid');
      const { data, error } = await getSupabase().rpc('request_withdrawal', {
        p_org: orgId,
        p_amount_cents: cents,
        p_pix_key_type: values.pix_key_type,
        p_pix_key: values.pix_key,
        p_holder_name: values.holder_name.trim(),
        p_holder_document: onlyDigits(values.holder_document),
        p_request_id: requestId,
      });
      if (error) throw error;
      return z.uuid().parse(data);
    },
    onSettled: () => invalidateOrg(queryClient, orgId),
  });
}

export function useCancelWithdrawal(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (withdrawalId: string) => {
      const { error } = await getSupabase().rpc('cancel_withdrawal', {
        p_withdrawal: withdrawalId,
      });
      if (error) throw error;
    },
    onSettled: () => invalidateOrg(queryClient, orgId),
  });
}

// ---------------------------------------------------------------------
// Equipe
// ---------------------------------------------------------------------

export type AdminWithdrawalFilter = 'open' | 'paid' | 'closed' | 'all';

const overviewSchema = z.object({
  requested_count: z.number().int(),
  requested_cents: z.number().int(),
  approved_count: z.number().int(),
  approved_cents: z.number().int(),
  paid_30d_cents: z.number().int(),
});

const adminWithdrawalSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  organization_name: z.string(),
  organization_kind: z.enum(orgKinds),
  organization_suspended: z.boolean(),
  amount_cents: z.number().int(),
  status: z.enum(withdrawalStatuses),
  pix_key_type: z.enum(pixKeyTypes),
  pix_key: z.string(),
  holder_name: z.string(),
  holder_document: z.string(),
  available_cents: z.number().int(),
  rejection_reason: z.string().nullable(),
  payout_reference: z.string().nullable(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
  paid_at: z.string().nullable(),
});
export type AdminWithdrawal = z.infer<typeof adminWithdrawalSchema>;

const settingsSchema = z.object({
  release_days_after_delivery: z.number().int(),
  release_days_after_shipping: z.number().int(),
  min_withdrawal_cents: z.number().int(),
});
export type WalletSettings = z.infer<typeof settingsSchema>;

export function useWithdrawalsOverview() {
  return useQuery({
    queryKey: walletKeys.adminOverview,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_withdrawals_overview');
      if (error) throw error;
      return overviewSchema.parse(data);
    },
  });
}

export function useAdminWithdrawals(status: AdminWithdrawalFilter, page: number) {
  return useQuery({
    queryKey: walletKeys.adminList(status, page),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_withdrawals', {
        p_status: status,
        p_limit: WITHDRAWALS_PAGE_SIZE,
        p_offset: (page - 1) * WITHDRAWALS_PAGE_SIZE,
      });
      if (error) throw error;
      return z.array(adminWithdrawalSchema).parse(data);
    },
  });
}

export type AdminWithdrawalAction =
  | { kind: 'approve'; id: string }
  | { kind: 'reject'; id: string; reason: string }
  | { kind: 'pay'; id: string; reference: string };

export function useAdminWithdrawalAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: AdminWithdrawalAction) => {
      const supabase = getSupabase();
      const { error } =
        action.kind === 'approve'
          ? await supabase.rpc('admin_approve_withdrawal', { p_withdrawal: action.id })
          : action.kind === 'reject'
            ? await supabase.rpc('admin_reject_withdrawal', {
                p_withdrawal: action.id,
                p_reason: action.reason,
              })
            : await supabase.rpc('admin_pay_withdrawal', {
                p_withdrawal: action.id,
                p_reference: action.reference,
              });
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: walletKeys.admin }),
  });
}

export function useWalletSettings() {
  return useQuery({
    queryKey: walletKeys.settings,
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('wallet_settings')
        .select('release_days_after_delivery, release_days_after_shipping, min_withdrawal_cents')
        .single();
      if (error) throw error;
      return settingsSchema.parse(data);
    },
  });
}

export function useSaveWalletSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (s: WalletSettings) => {
      const { error } = await getSupabase().rpc('admin_save_wallet_settings', {
        p_release_days_after_delivery: s.release_days_after_delivery,
        p_release_days_after_shipping: s.release_days_after_shipping,
        p_min_withdrawal_cents: s.min_withdrawal_cents,
      });
      if (error) throw error;
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: walletKeys.settings }),
        queryClient.invalidateQueries({ queryKey: ['wallet'] }),
      ]),
  });
}
