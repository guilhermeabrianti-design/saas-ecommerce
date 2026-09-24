import { Link, Navigate } from 'react-router';
import {
  Activity,
  Boxes,
  Building2,
  ChevronRight,
  Package,
  PackageCheck,
  ReceiptText,
  Store,
  UserRound,
} from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { OnboardingChecklist } from '@/features/dashboard/components/OnboardingChecklist';
import { SellerDashboard } from '@/features/dashboard/components/SellerDashboard';
import { useProfile } from '@/features/auth/profile';
import { roleLabels } from '@/features/auth/roles';
import { PendingInvitations } from '@/features/organizations/components/PendingInvitations';
import { useOrganization } from '@/features/organizations/organization-context';
import { orgRoleLabels } from '@/features/organizations/roles';
import { cn } from '@/utils/cn';

export function HomePage() {
  const profile = useProfile();
  const organization = useOrganization();

  if (profile.isPending || organization.isPending) return <PageLoader />;
  if (profile.isError || organization.isError) {
    return <Alert tone="error">Não foi possível carregar seus dados. Recarregue a página.</Alert>;
  }

  const { active } = organization;
  const isStaff = profile.data.role === 'admin';
  // Customers always work inside an organization; send them to create or join one.
  if (!active && !isStaff) return <Navigate to="/organizacao/nova" replace />;

  const isSeller = active?.organization.kind === 'seller';
  const firstName = profile.data.full_name.split(' ')[0];
  const shortcuts = [
    ...(active
      ? [
          {
            to: '/produtos',
            label: 'Produtos',
            detail: 'Catálogo interno da organização',
            icon: Package,
          },
          {
            to: '/estoque',
            label: 'Estoque',
            detail: 'Saldos e movimentações',
            icon: Boxes,
          },
          ...(active.organization.kind === 'seller'
            ? [
                {
                  to: '/pedidos',
                  label: 'Pedidos',
                  detail: 'Registre e acompanhe vendas',
                  icon: ReceiptText,
                },
                {
                  to: '/catalogo',
                  label: 'Catálogo de fornecedores',
                  detail: 'Importe produtos para vender',
                  icon: Store,
                },
              ]
            : [
                {
                  to: '/fornecimentos',
                  label: 'Pedidos de fornecimento',
                  detail: 'Envie pedidos das lojas vendedoras',
                  icon: PackageCheck,
                },
              ]),
          {
            to: '/organizacao',
            label: active.organization.name,
            detail: `Organização · ${orgRoleLabels[active.role]}`,
            icon: Building2,
          },
        ]
      : []),
    { to: '/conta', label: 'Minha conta', detail: 'Perfil, senha e sessão', icon: UserRound },
    {
      to: '/status',
      label: 'Status do sistema',
      detail: 'Diagnóstico do ambiente',
      icon: Activity,
    },
  ];

  return (
    <div className={cn('mx-auto space-y-8', isSeller ? 'max-w-4xl' : 'max-w-3xl')}>
      <div>
        <p className="text-brand font-mono text-xs font-medium tracking-widest uppercase">
          {roleLabels[profile.data.role]}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Olá, {firstName}</h1>
        <p className="text-muted mt-1 text-sm">
          {isSeller
            ? 'Acompanhe suas vendas e o que falta para começar a vender.'
            : 'Atalhos para o dia a dia.'}
        </p>
      </div>

      {!isStaff && <PendingInvitations />}

      {isSeller && (
        <>
          <OnboardingChecklist orgId={active.organization.id} />
          <SellerDashboard orgId={active.organization.id} role={active.role} />
        </>
      )}

      <ul className="grid gap-3 sm:grid-cols-2">
        {shortcuts.map(({ to, label, detail, icon: Icon }) => (
          <li key={to}>
            <Link
              to={to}
              className="border-border bg-surface hover:border-brand/50 flex items-center gap-3 rounded-xl border px-4 py-4 transition-colors"
            >
              <Icon className="text-brand size-5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{label}</span>
                <span className="text-muted block text-sm">{detail}</span>
              </span>
              <ChevronRight className="text-muted size-4" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
