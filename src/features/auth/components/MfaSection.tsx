import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { CopyField } from '@/components/ui/CopyField';
import { PageLoader } from '@/components/ui/PageLoader';
import { TextField } from '@/components/ui/TextField';
import { useAuth } from '../auth-context';
import { mfaErrorMessage, sessionAal, totpCodeSchema } from '../mfa';
import {
  useEnrollTotp,
  useTotpFactors,
  useUnenrollTotp,
  useVerifyTotp,
  type Enrollment,
} from '../mfa-api';

/** Código de 6 dígitos com validação local antes de ir ao servidor. */
export function TotpCodeForm({
  submitLabel,
  loading,
  error,
  onCode,
}: {
  submitLabel: string;
  loading: boolean;
  error: string | null;
  onCode: (code: string) => void;
}) {
  const [code, setCode] = useState('');
  const [local, setLocal] = useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = totpCodeSchema.safeParse(code);
        if (!parsed.success) {
          setLocal(parsed.error.issues[0]?.message ?? 'Código inválido');
          return;
        }
        setLocal(null);
        onCode(parsed.data);
      }}
    >
      <div className="w-44">
        <TextField
          label="Código do aplicativo"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          error={local ?? error ?? undefined}
        />
      </div>
      <Button type="submit" loading={loading}>
        {submitLabel}
      </Button>
    </form>
  );
}

function EnrollFlow({ onDone }: { onDone: () => void }) {
  const enroll = useEnrollTotp();
  const verify = useVerifyTotp();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);

  if (!enrollment) {
    return (
      <div className="space-y-3">
        {enroll.isError && <Alert tone="error">{mfaErrorMessage(enroll.error)}</Alert>}
        <Button
          loading={enroll.isPending}
          onClick={() => enroll.mutate(undefined, { onSuccess: setEnrollment })}
        >
          <ShieldCheck className="size-4" aria-hidden />
          Ativar verificação em duas etapas
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ol className="text-muted list-decimal space-y-1 pl-5 text-sm">
        <li>
          Abra um aplicativo autenticador (Google Authenticator, Microsoft Authenticator,
          1Password…).
        </li>
        <li>Leia o QR Code abaixo ou digite a chave.</li>
        <li>Informe o código de 6 números que aparecer.</li>
      </ol>
      <img
        src={enrollment.qrCode}
        alt="QR Code para o aplicativo autenticador"
        className="size-44 rounded-lg border border-black/10 bg-white p-2"
      />
      <CopyField value={enrollment.secret} label="Chave do autenticador" />
      <TotpCodeForm
        submitLabel="Confirmar"
        loading={verify.isPending}
        error={verify.isError ? mfaErrorMessage(verify.error) : null}
        onCode={(code) =>
          verify.mutate({ factorId: enrollment.factorId, code }, { onSuccess: onDone })
        }
      />
    </div>
  );
}

/** Minha conta → verificação em duas etapas (obrigatória para a equipe). */
export function MfaSection({ required = false }: { required?: boolean }) {
  const { session } = useAuth();
  const factors = useTotpFactors();
  const unenroll = useUnenrollTotp();
  const [done, setDone] = useState(false);

  if (factors.isPending) return <PageLoader />;
  if (factors.isError) return <Alert tone="error">{mfaErrorMessage(factors.error)}</Alert>;

  const verified = factors.data.filter((f) => f.status === 'verified');
  const aal2 = sessionAal(session) === 'aal2';

  if (!verified.length) {
    return (
      <div className="space-y-3">
        <p className="text-muted text-sm">
          Além da senha, pede um código do seu celular ao entrar.
          {required && ' Obrigatória para a equipe da plataforma.'}
        </p>
        <EnrollFlow onDone={() => setDone(true)} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {done && <Alert tone="success">Verificação em duas etapas ativada.</Alert>}
      {unenroll.isError && <Alert tone="error">{mfaErrorMessage(unenroll.error)}</Alert>}
      <p className="text-sm">
        <ShieldCheck className="text-success mr-1 inline size-4" aria-hidden />
        Ativada. Ao entrar, pedimos o código do aplicativo.
      </p>
      <ul className="divide-border divide-y text-sm">
        {verified.map((f) => (
          <li key={f.id} className="flex items-center justify-between gap-3 py-2">
            <span>{f.friendly_name ?? 'Aplicativo autenticador'}</span>
            {aal2 && !required && (
              <ConfirmButton
                confirmLabel="Remover mesmo"
                loading={unenroll.isPending}
                onConfirm={() => unenroll.mutate(f.id)}
              >
                Remover
              </ConfirmButton>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
