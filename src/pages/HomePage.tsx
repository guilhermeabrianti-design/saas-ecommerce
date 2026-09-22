import { Link } from 'react-router';
import { Activity, ChevronRight, UserRound } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { useProfile } from '@/features/auth/profile';
import { roleLabels } from '@/features/auth/roles';

const shortcuts = [
  { to: '/conta', label: 'Minha conta', detail: 'Perfil, senha e sessão', icon: UserRound },
  { to: '/status', label: 'Status do sistema', detail: 'Diagnóstico do ambiente', icon: Activity },
];

export function HomePage() {
  const profile = useProfile();

  if (profile.isPending) return <PageLoader />;
  if (profile.isError) {
    return <Alert tone="error">Não foi possível carregar seu perfil. Recarregue a página.</Alert>;
  }

  const firstName = profile.data.full_name.split(' ')[0];

  return (
    <div className="mx-auto max-w-3xl">
      <p className="text-brand font-mono text-xs font-medium tracking-widest uppercase">
        {roleLabels[profile.data.role]}
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Olá, {firstName}</h1>
      <p className="text-muted mt-1 text-sm">
        Produtos, pedidos, estoque e integrações serão habilitados aqui conforme cada módulo for
        liberado.
      </p>

      <ul className="mt-8 grid gap-3 sm:grid-cols-2">
        {shortcuts.map(({ to, label, detail, icon: Icon }) => (
          <li key={to}>
            <Link
              to={to}
              className="border-border bg-surface hover:border-brand/50 flex items-center gap-3 rounded-xl border px-4 py-4 transition-colors"
            >
              <Icon className="text-brand size-5" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{label}</span>
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
