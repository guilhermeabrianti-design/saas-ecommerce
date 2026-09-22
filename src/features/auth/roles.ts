/** Mirrors the `public.app_role` enum (supabase/migrations/*_auth_profiles.sql). */
export type AppRole = 'seller' | 'supplier' | 'admin';

export const roleLabels: Record<AppRole, string> = {
  seller: 'Vendedor',
  supplier: 'Fornecedor',
  admin: 'Equipe TheSigns',
};

/** Roles a user may pick at sign-up. `admin` is granted only server-side. */
export const signUpRoles = ['seller', 'supplier'] as const;
export type SignUpRole = (typeof signUpRoles)[number];

/**
 * UX-level check (hide/show screens). Authorization is always enforced by
 * RLS in the database — never rely on this for security.
 */
export function hasRole(role: AppRole | null | undefined, allowed: readonly AppRole[]): boolean {
  return role != null && allowed.includes(role);
}
