import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { useAuth } from '@/features/auth/auth-context';
import { feesAuditLabels } from '@/features/fees/fees';
import { moderationAuditLabels } from '@/features/moderation/moderation';
import { salesAuditLabels } from '@/features/sales/sales';
import { referralAuditLabels } from '@/features/affiliates/affiliates';
import { gamificationAuditLabels } from '@/features/gamification/gamification';
import { plansAuditLabels } from '@/features/plans/plans';
import { walletAuditLabels } from '@/features/wallet/wallet';
import { orgErrorMessage } from '@/features/organizations/errors';
import { orgKinds } from '@/features/organizations/roles';
import { getSupabase } from '@/lib/supabase';

export const ADMIN_PAGE_SIZE = 20;

const n = z.number().int();

const statsSchema = z.object({
  users: n,
  sellers: n,
  suppliers: n,
  suspended: n,
  orders_30d: n,
  gmv_30d_cents: n,
  active_connections: n,
  pending_suppliers: n,
  pending_listings: n,
});

const orgRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(orgKinds),
  created_at: z.string(),
  members: n,
  orders: n,
  suspended_at: z.string().nullable(),
  suspension_reason: z.string().nullable(),
  total_count: n,
});

const auditSchema = z.object({
  id: z.uuid(),
  admin_name: z.string().nullable(),
  action: z.string(),
  organization_id: z.uuid().nullable(),
  organization_name: z.string().nullable(),
  reason: z.string().nullable(),
  created_at: z.string(),
  total_count: n,
});

const suspendedSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  reason: z.string().nullable(),
  suspended_at: z.string(),
});

export type AdminStats = z.infer<typeof statsSchema>;
export type AdminOrganization = z.infer<typeof orgRowSchema>;
export type AuditEntry = z.infer<typeof auditSchema>;
export type SuspendedOrganization = z.infer<typeof suspendedSchema>;

export const adminKeys = {
  all: ['admin'] as const,
  stats: ['admin', 'stats'] as const,
  orgs: (search: string, page: number) => ['admin', 'orgs', search, page] as const,
  audit: (page: number) => ['admin', 'audit', page] as const,
  mySuspended: (userId: string | undefined) => ['my-suspended-organizations', userId] as const,
};

export function useAdminStats() {
  return useQuery({
    queryKey: adminKeys.stats,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_stats');
      if (error) throw error;
      return statsSchema.parse(data);
    },
  });
}

export function useAdminOrganizations(search: string, page: number) {
  return useQuery({
    queryKey: adminKeys.orgs(search, page),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_list_organizations', {
        p_search: search,
        p_limit: ADMIN_PAGE_SIZE,
        p_offset: (page - 1) * ADMIN_PAGE_SIZE,
      });
      if (error) throw error;
      const rows = z.array(orgRowSchema).parse(data);
      return { items: rows, total: rows[0]?.total_count ?? 0 };
    },
  });
}

export function useAuditEntries(page: number) {
  return useQuery({
    queryKey: adminKeys.audit(page),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_audit_entries', {
        p_limit: ADMIN_PAGE_SIZE,
        p_offset: (page - 1) * ADMIN_PAGE_SIZE,
      });
      if (error) throw error;
      const rows = z.array(auditSchema).parse(data);
      return { items: rows, total: rows[0]?.total_count ?? 0 };
    },
  });
}

export function useSetSuspension() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      orgId,
      suspended,
      reason,
    }: {
      orgId: string;
      suspended: boolean;
      reason: string;
    }) => {
      const { error } = await getSupabase().rpc('admin_set_suspension', {
        p_org: orgId,
        p_suspended: suspended,
        p_reason: reason.trim() || null,
      });
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: adminKeys.all }),
  });
}

/** Organizações suspensas em que o usuário é membro (para explicar o bloqueio). */
export function useMySuspendedOrganizations() {
  const { user } = useAuth();
  const userId = user?.id;
  return useQuery({
    queryKey: adminKeys.mySuspended(userId),
    enabled: userId !== undefined,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('my_suspended_organizations');
      if (error) throw error;
      return z.array(suspendedSchema).parse(data);
    },
  });
}

export const auditActionLabels: Record<string, string> = {
  'organization.suspended': 'Empresa suspensa',
  'organization.reactivated': 'Empresa reativada',
  ...feesAuditLabels,
  ...moderationAuditLabels,
  ...salesAuditLabels,
  ...walletAuditLabels,
  ...referralAuditLabels,
  ...gamificationAuditLabels,
  ...plansAuditLabels,
  'checkout.refund': 'Estorno do checkout',
};

const messages: Partial<Record<string, string>> = {
  'admin.forbidden': 'Acesso restrito à equipe da plataforma.',
  'admin.not_found': 'Empresa não encontrada.',
  'admin.no_change': 'A empresa já está neste estado. Atualize a página.',
  'admin.reason_required': 'Informe o motivo da suspensão (ao menos 3 caracteres).',
  'admin.invalid': 'Requisição inválida.',
};

export function adminErrorMessage(error: unknown): string {
  const { message } = (error ?? {}) as { message?: unknown };
  if (typeof message === 'string' && messages[message]) return messages[message];
  return orgErrorMessage(error);
}
