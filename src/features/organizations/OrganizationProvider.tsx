import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '@/features/auth/auth-context';
import { useMemberships } from './api';
import {
  OrganizationContext,
  resolveActiveMembership,
  type OrganizationContextValue,
} from './organization-context';

const storageKey = (userId: string) => `ts-active-org:${userId}`;

function readStored(userId: string | undefined): string | null {
  if (!userId) return null;
  try {
    return localStorage.getItem(storageKey(userId));
  } catch {
    return null;
  }
}

export function OrganizationProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;
  const memberships = useMemberships();
  // Keyed by user so switching accounts never carries the previous choice over.
  const [choice, setChoice] = useState<{ userId: string; orgId: string } | null>(null);

  const preferredId = choice && choice.userId === userId ? choice.orgId : readStored(userId);

  const selectOrganization = useCallback(
    (orgId: string) => {
      if (!userId) return;
      setChoice({ userId, orgId });
      try {
        localStorage.setItem(storageKey(userId), orgId);
      } catch {
        // storage unavailable — the choice lasts for this session only
      }
    },
    [userId],
  );

  const value = useMemo<OrganizationContextValue>(() => {
    const list = memberships.data ?? [];
    return {
      memberships: list,
      isPending: userId !== undefined && memberships.isPending,
      isError: memberships.isError,
      active: resolveActiveMembership(list, preferredId),
      selectOrganization,
    };
  }, [
    memberships.data,
    memberships.isPending,
    memberships.isError,
    userId,
    preferredId,
    selectOrganization,
  ]);

  return <OrganizationContext.Provider value={value}>{children}</OrganizationContext.Provider>;
}
