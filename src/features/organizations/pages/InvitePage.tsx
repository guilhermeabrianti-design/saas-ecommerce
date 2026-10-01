import { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Users } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { useAuth } from '@/features/auth/auth-context';
import { useAcceptInviteLink, useInvitePreview } from '../api';
import { useOrganization } from '../organization-context';
import {
  clearInviteToken,
  inviteErrorMessage,
  isInviteToken,
  rememberInviteToken,
} from '../invite';
import { orgKindLabels, orgRoleLabels } from '../roles';

/**
 * Link de convite. Sem conta: cria a conta já como parte da empresa (o
 * token fica guardado até o primeiro acesso). Com conta: entra na hora.
 */
export function InvitePage() {
  const { token = '' } = useParams();
  const valid = isInviteToken(token);
  const { status } = useAuth();
  const preview = useInvitePreview(token);
  const accept = useAcceptInviteLink();
  const { selectOrganization } = useOrganization();
  const navigate = useNavigate();

  // Guarda o link só se ele vale; vencido ou usado é esquecido.
  const usable = valid && !!preview.data;
  const settled = !preview.isPending;
  useEffect(() => {
    if (usable) rememberInviteToken(token);
    else if (settled) clearInviteToken();
  }, [usable, settled, token]);

  if (!valid) return <Alert tone="error">Link de convite inválido.</Alert>;
  if (preview.isPending || status === 'loading') return <PageLoader />;
  if (preview.isError || !preview.data) {
    return (
      <Alert tone="error">
        Este link de convite não vale mais (usado, vencido ou cancelado). Peça um novo a quem
        convidou você.
      </Alert>
    );
  }
  const p = preview.data;

  return (
    <div className="space-y-5">
      <div className="space-y-2 text-center">
        <Users className="text-brand mx-auto size-8" aria-hidden />
        <h1 className="text-xl font-semibold tracking-tight">Convite para {p.organization_name}</h1>
        <p className="text-muted text-sm">
          Você vai entrar na equipe como <strong>{orgRoleLabels[p.role]}</strong> (
          {orgKindLabels[p.kind].toLowerCase()}).
        </p>
      </div>

      {accept.isError && <Alert tone="error">{inviteErrorMessage(accept.error)}</Alert>}

      {status === 'authenticated' ? (
        <Button
          className="w-full"
          loading={accept.isPending}
          onClick={() =>
            accept.mutate(token, {
              onSuccess: (orgId) => {
                clearInviteToken();
                selectOrganization(orgId);
                void navigate('/', { replace: true });
              },
            })
          }
        >
          Entrar na equipe
        </Button>
      ) : null}
      {status === 'authenticated' ? (
        <Button
          variant="ghost"
          className="w-full"
          onClick={() => {
            clearInviteToken();
            void navigate('/', { replace: true });
          }}
        >
          Agora não
        </Button>
      ) : (
        <div className="space-y-3">
          <Link
            to={`/cadastro?convite=${token}`}
            className="bg-brand text-brand-fg hover:bg-brand/90 flex h-10 w-full items-center justify-center rounded-lg text-sm font-medium"
          >
            Criar minha conta
          </Link>
          <p className="text-muted text-center text-sm">
            Já tem conta?{' '}
            <Link to="/entrar" className="text-brand font-medium hover:underline">
              Entrar
            </Link>{' '}
            — o convite é aplicado ao entrar.
          </p>
        </div>
      )}
    </div>
  );
}
