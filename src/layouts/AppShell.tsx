import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import {
  Activity,
  Banknote,
  PiggyBank,
  ChartColumn,
  CreditCard,
  Percent,
  ShieldCheck,
  Building2,
  GraduationCap,
  Gift,
  Star,
  Trophy,
  LifeBuoy,
  House,
  ListChecks,
  LogOut,
  Megaphone,
  Package,
  PackageCheck,
  Plug,
  Radio,
  ReceiptText,
  Store,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { EnvBadge } from '@/components/ui/EnvBadge';
import { useMySuspendedOrganizations } from '@/features/admin/api';
import { SuspensionNotice } from '@/features/admin/components/SuspensionNotice';
import { useAuth } from '@/features/auth/auth-context';
import { SupplierApprovalNotice } from '@/features/moderation/components/SupplierApprovalNotice';
import { useProfile } from '@/features/auth/profile';
import { roleLabels } from '@/features/auth/roles';
import { NotificationBell } from '@/features/notifications/components/NotificationBell';
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
  /** Platform staff (`admin` accounts): only they see it, and they see no tenant screens. */
  staffOnly?: boolean;
  /** Hidden for staff, who have no organization. */
  tenantOnly?: boolean;
}

const navItems: NavItem[] = [
  { to: '/', label: 'Início', icon: House, requiresAuth: true },
  {
    to: '/academia',
    label: 'Academia',
    icon: GraduationCap,
    requiresAuth: true,
    tenantOnly: true,
    orgKind: 'seller',
  },
  { to: '/admin', label: 'Administração', icon: ShieldCheck, requiresAuth: true, staffOnly: true },
  {
    to: '/admin/moderacao',
    label: 'Moderação',
    icon: ListChecks,
    requiresAuth: true,
    staffOnly: true,
  },
  {
    to: '/admin/academia',
    label: 'Academia',
    icon: GraduationCap,
    requiresAuth: true,
    staffOnly: true,
  },
  {
    to: '/admin/lives',
    label: 'Campanhas de live',
    icon: Radio,
    requiresAuth: true,
    staffOnly: true,
  },
  {
    to: '/admin/pagamentos',
    label: 'Pagamentos',
    icon: CreditCard,
    requiresAuth: true,
    staffOnly: true,
  },
  {
    to: '/admin/saques',
    label: 'Saques',
    icon: Banknote,
    requiresAuth: true,
    staffOnly: true,
  },
  {
    to: '/admin/avaliacoes',
    label: 'Avaliações',
    icon: Star,
    requiresAuth: true,
    staffOnly: true,
  },
  {
    to: '/admin/suporte',
    label: 'Suporte',
    icon: LifeBuoy,
    requiresAuth: true,
    staffOnly: true,
  },
  {
    to: '/admin/indicacoes',
    label: 'Indicações',
    icon: Gift,
    requiresAuth: true,
    staffOnly: true,
  },
  {
    to: '/admin/gamificacao',
    label: 'Gamificação',
    icon: Trophy,
    requiresAuth: true,
    staffOnly: true,
  },
  {
    to: '/admin/taxas',
    label: 'Taxas e comissões',
    icon: Percent,
    requiresAuth: true,
    staffOnly: true,
  },
  { to: '/produtos', label: 'Produtos', icon: Package, requiresAuth: true, tenantOnly: true },
  {
    to: '/pedidos',
    label: 'Pedidos',
    icon: ReceiptText,
    requiresAuth: true,
    tenantOnly: true,
    orgKind: 'seller',
  },
  {
    to: '/central',
    label: 'Central de Vendas',
    icon: Megaphone,
    requiresAuth: true,
    tenantOnly: true,
    orgKind: 'seller',
  },
  {
    to: '/catalogo',
    label: 'Catálogo',
    icon: Store,
    requiresAuth: true,
    tenantOnly: true,
    orgKind: 'seller',
  },
  {
    to: '/integracoes',
    label: 'Integrações',
    icon: Plug,
    requiresAuth: true,
    tenantOnly: true,
    orgKind: 'seller',
  },
  {
    to: '/fornecimentos',
    label: 'Fornecimentos',
    icon: PackageCheck,
    requiresAuth: true,
    tenantOnly: true,
    orgKind: 'supplier',
  },
  { to: '/analises', label: 'Análises', icon: ChartColumn, requiresAuth: true, tenantOnly: true },
  { to: '/carteira', label: 'Carteira', icon: PiggyBank, requiresAuth: true, tenantOnly: true },
  { to: '/reputacao', label: 'Reputação', icon: Star, requiresAuth: true, tenantOnly: true },
  { to: '/conquistas', label: 'Conquistas', icon: Trophy, requiresAuth: true, tenantOnly: true },
  {
    to: '/indicacoes',
    label: 'Indique e ganhe',
    icon: Gift,
    requiresAuth: true,
    tenantOnly: true,
    orgKind: 'seller',
  },
  {
    to: '/organizacao',
    label: 'Empresa',
    icon: Building2,
    requiresAuth: true,
    tenantOnly: true,
  },
  { to: '/suporte', label: 'Suporte', icon: LifeBuoy, requiresAuth: true, tenantOnly: true },
  { to: '/conta', label: 'Minha conta', icon: UserRound, requiresAuth: true },
  {
    to: '/status',
    label: 'Status do sistema',
    icon: Activity,
    requiresAuth: true,
    staffOnly: true,
  },
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
  const profile = useProfile();
  const isStaff = profile.data?.role === 'admin';
  const suspended = useMySuspendedOrganizations();
  const items = navItems.filter(
    (item) =>
      (authenticated || !item.requiresAuth) &&
      (!item.staffOnly || isStaff) &&
      (!item.tenantOnly || !isStaff) &&
      (!item.orgKind || item.orgKind === active?.organization.kind),
  );

  const nav = items.map(({ to, label, icon: Icon }) => (
    <NavLink
      key={to}
      to={to}
      end={to === '/' || to === '/admin' || to === '/academia'}
      className={linkClass}
    >
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
              {authenticated && active && (
                <span className="text-muted hidden max-w-48 truncate text-sm font-medium lg:block">
                  {active.organization.name}
                </span>
              )}
              {authenticated && <NotificationBell />}
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
          {authenticated && <SuspensionNotice organizations={suspended.data ?? []} />}
          {authenticated && <SupplierApprovalNotice />}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
