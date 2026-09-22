import { Link, useNavigate, useSearchParams } from 'react-router';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { useAuth } from '../auth-context';
import { AuthHeading } from '../components/AuthHeading';
import { ChangePasswordForm } from '../components/ChangePasswordForm';
import { authLinkErrorMessage } from '../errors';
import { AuthUnavailable } from '../guards';

/**
 * Landing page of the recovery e-mail. supabase-js exchanges the `?code=`
 * for a (recovery) session before AuthProvider reports a status.
 */
export function ResetPasswordPage() {
  const { status } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  if (status === 'unconfigured') return <AuthUnavailable />;
  if (status === 'loading') return <PageLoader />;

  if (status !== 'authenticated') {
    return (
      <>
        <AuthHeading title="Redefinir senha" />
        <Alert tone="error">
          <p>
            {authLinkErrorMessage(params.get('error_code')) ??
              'Link inválido ou expirado. Solicite um novo.'}
          </p>
          <Link to="/recuperar-senha" className="inline-block font-medium underline">
            Solicitar novo link
          </Link>
        </Alert>
      </>
    );
  }

  return (
    <>
      <AuthHeading title="Redefinir senha">Escolha uma nova senha para sua conta.</AuthHeading>
      <ChangePasswordForm onSuccess={() => navigate('/', { replace: true })} />
    </>
  );
}
