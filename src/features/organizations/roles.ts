/** Mirrors `public.org_role` / `public.org_kind` (supabase/migrations/*_organizations.sql). */
export const orgRoles = ['owner', 'admin', 'member'] as const;
export type OrgRole = (typeof orgRoles)[number];

export const orgKinds = ['seller', 'supplier'] as const;
export type OrgKind = (typeof orgKinds)[number];

export const orgRoleLabels: Record<OrgRole, string> = {
  owner: 'Proprietário',
  admin: 'Administrador',
  member: 'Membro',
};

export const orgKindLabels: Record<OrgKind, string> = {
  seller: 'Vendedor',
  supplier: 'Fornecedor',
};

/**
 * UX-level permissions (which buttons to show). The same rules are enforced by
 * the RPCs and RLS in the database — these never grant anything by themselves.
 */
export const orgPermissions = {
  rename: (role: OrgRole) => role === 'owner' || role === 'admin',
  manageInvitations: (role: OrgRole) => role === 'owner' || role === 'admin',
  changeRoles: (role: OrgRole) => role === 'owner',
  /** Create/edit products and other catalog data. */
  editCatalog: (role: OrgRole) => role === 'owner' || role === 'admin',
  /** Financeiro (recebimentos, estornos, livro-razão): só owner/admin. */
  viewFinance: (role: OrgRole) => role === 'owner' || role === 'admin',
  /** Análises de vendas/fornecimentos (inclui custo e margem): só owner/admin. */
  viewAnalytics: (role: OrgRole) => role === 'owner' || role === 'admin',
  /** Conexões com marketplaces, vínculos de SKU e reprocessamento de pedidos. */
  manageIntegrations: (role: OrgRole) => role === 'owner' || role === 'admin',
  /** Roles `role` may invite as. */
  invitableRoles: (role: OrgRole): OrgRole[] =>
    role === 'owner' ? ['member', 'admin'] : role === 'admin' ? ['member'] : [],
  /** Whether `role` may remove someone else holding `target`. */
  removeMember: (role: OrgRole, target: OrgRole) =>
    role === 'owner' || (role === 'admin' && target === 'member'),
};
