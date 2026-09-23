import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import {
  Activity,
  Boxes,
  Building2,
  House,
  LogOut,
  Package,
  PackageCheck,
  ReceiptText,
  Store,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { EnvBadge } from '@/components/ui/EnvBadge';
import { useAuth } from '@/features/auth/auth-context';
import { useProfile } from '@/features/auth/profile';
import { roleLabels } from '@/features/auth/roles';
import { OrganizationSwitcher } from '@/features/organizations/components/OrganizationSwitcher';
import { useOrganization } from '@/features/organizations/organization-context';
import type { OrgKind } from '@/features/organizations/roles';
import { cn } from '@/utils/cn';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  requiresAuth: boolean;
  /** Only shown when the active organization is of this kind. */
  orgKind?: OrgKind;
}

const navItems: NavItem[] = [
  { to: '/', label: 'Início', icon: House, requiresAuth: true },
  { to: '/produtos', label: 'Produtos', icon: Package, requiresAuth: true },
  { to: '/estoque', label: 'Estoque', icon: Boxes, requiresAuth: true },
  { to: '/pedidos', label: 'Pedidos', icon: ReceiptText, requiresAuth: true, orgKind: 'seller' },
  { to: '/catalogo', label: 'Catálogo', icon: Store, requiresAuth: true, orgKind: 'seller' },
  {
    to: '/fornecimentos',
    label: 'Fornecimentos',
    icon: PackageCheck,
    requiresAuth: true,
    orgKind: 'supplier',
  },
  { to: '/organizacao', label: 'Organização', icon: Building2, requiresAuth: true },
  { to: '/conta', label: 'Minha conta', icon: UserRound, requiresAuth: true },
  { to: '/status', label: 'Status do sistema', icon: Activity, requiresAuth: false },
];

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
    isActive ? 'bg-brand/10 text-brand' : 'text-muted hover:bg-surface-2 hover:text-fg',
  );

function UserMenu() {
  const { signOut } = useAuth();
  const profile = useProfile();
  const [signingOut, setSigningOut] = useState(false);

  return (
    <div className="flex items-center gap-3">
      {profile.data && (
        <div className="hidden text-right leading-tight sm:block">
          <p className="max-w-40 truncate text-sm font-medium">{profile.data.full_name}</p>
          <p className="text-muted text-xs">{roleLabels[profile.data.role]}</p>
        </div>
      )}
      <button
        type="button"
        onClick={async () => {
          setSigningOut(true);
          await signOut();
        }}
        disabled={signingOut}
        className="border-border text-muted hover:bg-surface-2 hover:text-fg inline-flex size-9 items-center justify-center rounded-lg border transition-colors disabled:opacity-60"
        aria-label="Sair"
        title="Sair"
      >
        <LogOut className="size-4" aria-hidden />
      </button>
    </div>
  );
}

export function AppShell() {
  const { status } = useAuth();
  const authenticated = status === 'authenticated';
  const { active } = useOrganization();
  const items = navItems.filter(
    (item) =>
      (authenticated || !item.requiresAuth) &&
      (!item.orgKind || item.orgKind === active?.organization.kind),
  );

  const nav = items.map(({ to, label, icon: Icon }) => (
    <NavLink key={to} to={to} end={to === '/'} className={linkClass}>
      <Icon className="size-4" aria-hidden />
      {label}
    </NavLink>
  ));

  return (
    <div className="flex h-full">
      <aside className="border-border bg-surface hidden w-64 shrink-0 flex-col border-r md:flex">
        <div className="border-border flex h-16 items-center border-b px-5">
          <Logo />
        </div>
        <nav className="flex-1 space-y-1 p-3" aria-label="Principal">
          {nav}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-border bg-surface border-b">
          <div className="flex h-16 items-center justify-between gap-4 px-4 md:px-6">
            <div className="md:hidden">
              <Logo />
            </div>
            <div className="ml-auto flex min-w-0 items-center gap-3">
              {authenticated && <OrganizationSwitcher />}
              <EnvBadge />
              <ThemeToggle />
              {authenticated ? (
                <UserMenu />
              ) : (
                status === 'unauthenticated' && (
                  <Link
                    to="/entrar"
                    className="bg-brand text-brand-fg hover:bg-brand/90 inline-flex h-9 items-center rounded-lg px-3 text-sm font-medium"
                  >
                    Entrar
                  </Link>
                )
              )}
            </div>
          </div>
          <nav
            className="flex gap-1 overflow-x-auto px-3 pb-2 md:hidden"
            aria-label="Principal (móvel)"
          >
            {nav}
          </nav>
        </header>
        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
