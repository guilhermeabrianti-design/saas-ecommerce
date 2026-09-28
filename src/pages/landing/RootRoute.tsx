import { Navigate } from 'react-router';
import { PageLoader } from '@/components/ui/PageLoader';
import { mfaRequirement } from '@/features/auth/mfa';
import { useAuth } from '@/features/auth/auth-context';
import { AppShell } from '@/layouts/AppShell';
import { LandingPage } from './LandingPage';

/** "/": landing para visitantes; o app (Início) para quem entrou. */
export function RootRoute() {
  const { status, session, user } = useAuth();
  if (status === 'loading') return <PageLoader />;
  if (status === 'authenticated') {
    if (mfaRequirement({ session, user, isStaff: false }) === 'verify') {
      return <Navigate to="/verificacao" replace />;
    }
    return <AppShell />;
  }
  return <LandingPage />;
}
