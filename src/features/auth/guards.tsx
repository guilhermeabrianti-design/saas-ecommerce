import { Link, Navigate, Outlet, useLocation, useSearchParams } from 'react-router';
import { ShieldX } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { useAuth } from './auth-context';
import { useProfile } from './profile';
import { safeNextPath } from './redirect';
import { hasRole, type AppRole } from './roles';

export function AuthUnavailable() {
  return (
    <Alert tone="info">
      <p className="font-medium">Autenticação não configurada</p>
      <p>
        Defina <code className="font-mono text-xs">VITE_SUPABASE_URL</code> e{' '}
        <code className="font-mono text-xs">VITE_SUPABASE_ANON_KEY</code> em{' '}
        <code className="font-mono text-xs">.env.local</code>.
      </p>
      <Link to="/status" className="inline-block font-medium underline">
        Ver status do sistema
      </Link>
    </Alert>
  );
}

/** Protected area: redirects anonymous visitors to sign-in, preserving where they were going. */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <PageLoader />;
  if (status !== 'authenticated') {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/entrar?next=${next}`} replace />;
  }
  return <Outlet />;
}

/** Public auth pages (sign-in, sign-up…): signed-in users are sent on to the app. */
export function RedirectIfAuthenticated() {
  const { status } = useAuth();
  const [params] = useSearchParams();

  if (status === 'unconfigured') return <AuthUnavailable />;
  if (status === 'loading') return <PageLoader />;
  if (status === 'authenticated') return <Navigate to={safeNextPath(params.get('next'))} replace />;
  return <Outlet />;
}

/** UX gate by role. The database (RLS) enforces the same rule independently. */
export function RequireRole({ allowed }: { allowed: readonly AppRole[] }) {
  const profile = useProfile();

  if (profile.isPending) return <PageLoader />;
  if (profile.isError) {
    return <Alert tone="error">Não foi possível carregar seu perfil. Recarregue a página.</Alert>;
  }
  if (!hasRole(profile.data.role, allowed)) {
    return (
      <div className="mx-auto max-w-md py-24 text-center">
        <ShieldX className="text-danger mx-auto size-8" aria-hidden />
        <h1 className="mt-3 text-xl font-semibold tracking-tight">Acesso negado</h1>
        <p className="text-muted mt-1 text-sm">Sua conta não tem permissão para esta área.</p>
        <Link to="/" className="text-brand mt-6 inline-block text-sm font-medium hover:underline">
          Voltar ao início
        </Link>
      </div>
    );
  }
  return <Outlet />;
}
