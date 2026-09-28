import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { useAuth } from '@/features/auth/auth-context';
import { getSupabase } from '@/lib/supabase';
import { orgKinds, orgRoles, type OrgRole } from './roles';

const orgRole = z.enum(orgRoles);
const orgKind = z.enum(orgKinds);

const membershipSchema = z.object({
  role: orgRole,
  organization: z.object({ id: z.uuid(), name: z.string(), kind: orgKind }),
});

const memberSchema = z.object({
  user_id: z.uuid(),
  full_name: z.string(),
  email: z.string(),
  role: orgRole,
  joined_at: z.string(),
});

const invitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: orgRole,
  expires_at: z.string(),
});

const myInvitationSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  organization_name: z.string(),
  organization_kind: orgKind,
  role: orgRole,
  invited_by_name: z.string().nullable(),
  expires_at: z.string(),
});

export type Membership = z.infer<typeof membershipSchema>;
export type Member = z.infer<typeof memberSchema>;
export type Invitation = z.infer<typeof invitationSchema>;
export type MyInvitation = z.infer<typeof myInvitationSchema>;

export const orgKeys = {
  memberships: (userId: string | undefined) => ['memberships', userId] as const,
  members: (orgId: string) => ['organization-members', orgId] as const,
  invitations: (orgId: string) => ['organization-invitations', orgId] as const,
  myInvitations: (userId: string | undefined) => ['my-invitations', userId] as const,
};

/** Organizations the signed-in user belongs to, with their role in each. */
export function useMemberships() {
  const { user } = useAuth();
  const userId = user?.id;
  return useQuery({
    queryKey: orgKeys.memberships(userId),
    enabled: userId !== undefined,
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('organization_members')
        .select('role, organization:organizations!inner(id, name, kind)')
        .eq('user_id', userId!)
        .order('created_at');
      if (error) throw error;
      return z.array(membershipSchema).parse(data);
    },
  });
}

export function useOrganizationMembers(orgId: string) {
  return useQuery({
    queryKey: orgKeys.members(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('list_organization_members', {
        p_org: orgId,
      });
      if (error) throw error;
      return z.array(memberSchema).parse(data);
    },
  });
}

/** Pending invitations of an organization (RLS: owner/admin only). */
export function useOrganizationInvitations(orgId: string) {
  return useQuery({
    queryKey: orgKeys.invitations(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('organization_invitations')
        .select('id, email, role, expires_at')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return z.array(invitationSchema).parse(data);
    },
  });
}

/** Invitations addressed to the signed-in user's e-mail. */
export function useMyInvitations() {
  const { user } = useAuth();
  const userId = user?.id;
  return useQuery({
    queryKey: orgKeys.myInvitations(userId),
    enabled: userId !== undefined,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('my_pending_invitations');
      if (error) throw error;
      return z.array(myInvitationSchema).parse(data);
    },
  });
}

async function rpc(fn: string, args: Record<string, unknown>) {
  const { data, error } = await getSupabase().rpc(fn, args);
  if (error) throw error;
  return data as unknown;
}

export function useCreateOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, referralCode }: { name: string; referralCode?: string | null }) =>
      z.uuid().parse(
        await rpc('create_organization', {
          p_name: name,
          p_referral_code: referralCode?.trim() || null,
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['memberships'] }),
  });
}

export function useRenameOrganization(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const { error } = await getSupabase().from('organizations').update({ name }).eq('id', orgId);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['memberships'] }),
  });
}

export function useInviteMember(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, role }: { email: string; role: OrgRole }) =>
      rpc('invite_member', { p_org: orgId, p_email: email, p_role: role }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKeys.invitations(orgId) }),
  });
}

export function useRevokeInvitation(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) => rpc('revoke_invitation', { p_invitation: invitationId }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: orgKeys.invitations(orgId) }),
  });
}

export function useAcceptInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (invitationId: string) =>
      z.uuid().parse(await rpc('accept_invitation', { p_invitation: invitationId })),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['my-invitations'] }),
        queryClient.invalidateQueries({ queryKey: ['memberships'] }),
      ]),
  });
}

export function useDeclineInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) => rpc('decline_invitation', { p_invitation: invitationId }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['my-invitations'] }),
  });
}

export function useUpdateMemberRole(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: OrgRole }) =>
      rpc('update_member_role', { p_org: orgId, p_user: userId, p_role: role }),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: orgKeys.members(orgId) }),
        queryClient.invalidateQueries({ queryKey: ['memberships'] }),
      ]),
  });
}

/** Removes a member, or leaves the organization when `userId` is the caller. */
export function useRemoveMember(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => rpc('remove_member', { p_org: orgId, p_user: userId }),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: orgKeys.members(orgId) }),
        queryClient.invalidateQueries({ queryKey: ['memberships'] }),
      ]),
  });
}
