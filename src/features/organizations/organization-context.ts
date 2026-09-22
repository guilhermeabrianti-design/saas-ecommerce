import { createContext, useContext } from 'react';
import type { Membership } from './api';

export interface OrganizationContextValue {
  memberships: Membership[];
  isPending: boolean;
  isError: boolean;
  /** The organization the user is working in; null when they belong to none. */
  active: Membership | null;
  selectOrganization: (organizationId: string) => void;
}

export const OrganizationContext = createContext<OrganizationContextValue | null>(null);

export function useOrganization() {
  const ctx = useContext(OrganizationContext);
  if (!ctx) throw new Error('useOrganization must be used within OrganizationProvider');
  return ctx;
}

/**
 * The stored choice when the user still belongs to it, otherwise the first
 * membership. A stale or tampered stored id never selects a foreign tenant
 * (and RLS would return nothing for it anyway).
 */
export function resolveActiveMembership(
  memberships: Membership[],
  preferredId: string | null,
): Membership | null {
  return memberships.find((m) => m.organization.id === preferredId) ?? memberships[0] ?? null;
}
