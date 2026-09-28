import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { useAuth } from '../auth-context';
import { AuthHeading } from '../components/AuthHeading';
import { TotpCodeForm } from '../components/MfaSection';
import { mfaErrorMessage, mfaRequirement } from '../mfa';
import { useTotpFactors, useVerifyTotp } from '../mfa-api';
import { safeNextPath } from '../redirect';

/** /verificacao: segundo passo do login para quem ativou a verificação em duas etapas. */
export function MfaVerifyPage() {
  const { status, session, user, signOut } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNextPath(params.get('next'));
  const factors = useTotpFactors();
  const verify = useVerifyTotp();

  if (status === 'loading') return <PageLoader />;
  if (status !== 'authenticated') return <Navigate to="/entrar" replace />;
  if (mfaRequirement({ session, user, isStaff: false }) !== 'verify') {
    return <Navigate to={next} replace />;
  }
  if (factors.isPending) return <PageLoader />;

  const factor = factors.data?.find((f) => f.status === 'verified');

  return (
    <div className="space-y-6">
      <AuthHeading title="Verificação em duas etapas">
        Digite o código de 6 números do seu aplicativo autenticador.
      </AuthHeading>
      {factors.isError || !factor ? (
        <Alert tone="error">
          {factors.isError
            ? mfaErrorMessage(factors.error)
            : 'Nenhum aplicativo autenticador encontrado.'}
        </Alert>
      ) : (
        <TotpCodeForm
          submitLabel="Verificar"
          loading={verify.isPending}
          error={verify.isError ? mfaErrorMessage(verify.error) : null}
          onCode={(code) =>
            verify.mutate(
              { factorId: factor.id, code },
              { onSuccess: () => void navigate(next, { replace: true }) },
            )
          }
        />
      )}
      <Button variant="ghost" onClick={() => void signOut()}>
        Sair e entrar com outra conta
      </Button>
    </div>
  );
}
