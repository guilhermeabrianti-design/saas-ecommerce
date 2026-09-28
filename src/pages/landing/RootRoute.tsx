import { PageLoader } from '@/components/ui/PageLoader';
import { useAuth } from '@/features/auth/auth-context';
import { AppShell } from '@/layouts/AppShell';
import { LandingPage } from './LandingPage';

/** "/": landing para visitantes; o app (Início) para quem entrou. */
export function RootRoute() {
  const { status } = useAuth();
  if (status === 'loading') return <PageLoader />;
  if (status === 'authenticated') return <AppShell />;
  return <LandingPage />;
}
