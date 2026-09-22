import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { isAuthError } from '@supabase/supabase-js';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { getSupabase } from '@/lib/supabase';
import { AuthHeading } from '../components/AuthHeading';
import { authErrorMessage, authLinkErrorMessage } from '../errors';
import { authRedirectUrl } from '../redirect';
import { signInSchema, type SignInValues } from '../schemas';
import { lockSecondsAfter } from '../throttle';

export function SignInPage() {
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(() =>
    authLinkErrorMessage(params.get('error_code')),
  );
  const [unconfirmedEmail, setUnconfirmedEmail] = useState<string | null>(null);
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: '', password: '' },
  });

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const id = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [secondsLeft]);

  const onSubmit = handleSubmit(async (values) => {
    if (secondsLeft > 0) return;
    setError(null);
    setUnconfirmedEmail(null);

    const { error: signInError } = await getSupabase().auth.signInWithPassword(values);
    if (!signInError) {
      // RedirectIfAuthenticated navigates once the session is stored.
      setFailedAttempts(0);
      return;
    }

    setError(authErrorMessage(signInError));
    if (isAuthError(signInError) && signInError.code === 'email_not_confirmed') {
      setUnconfirmedEmail(values.email);
      setResendState('idle');
    }
    if (isAuthError(signInError) && signInError.code === 'invalid_credentials') {
      const failures = failedAttempts + 1;
      setFailedAttempts(failures);
      setSecondsLeft(lockSecondsAfter(failures));
    }
  });

  const resendConfirmation = async () => {
    if (!unconfirmedEmail) return;
    setResendState('sending');
    const { error: resendError } = await getSupabase().auth.resend({
      type: 'signup',
      email: unconfirmedEmail,
      options: { emailRedirectTo: authRedirectUrl('/entrar') },
    });
    if (resendError) {
      setError(authErrorMessage(resendError));
      setResendState('idle');
    } else {
      setResendState('sent');
    }
  };

  const locked = secondsLeft > 0;

  return (
    <>
      <AuthHeading title="Entrar">Acesse sua conta TheSigns.</AuthHeading>

      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {error && (
          <Alert tone="error">
            <p>{error}</p>
            {unconfirmedEmail && resendState !== 'sent' && (
              <button
                type="button"
                onClick={resendConfirmation}
                disabled={resendState === 'sending'}
                className="font-medium underline disabled:opacity-60"
              >
                Reenviar e-mail de confirmação
              </button>
            )}
          </Alert>
        )}
        {resendState === 'sent' && (
          <Alert tone="success">Se a conta existir, um novo link de confirmação foi enviado.</Alert>
        )}
        {locked && (
          <Alert tone="info">
            Muitas tentativas incorretas. Tente novamente em {secondsLeft}s.
          </Alert>
        )}

        <TextField
          label="E-mail"
          type="email"
          autoComplete="email"
          inputMode="email"
          autoFocus
          error={errors.email?.message}
          {...register('email')}
        />
        <div className="space-y-1.5">
          <TextField
            label="Senha"
            type="password"
            autoComplete="current-password"
            error={errors.password?.message}
            {...register('password')}
          />
          <div className="text-right">
            <Link to="/recuperar-senha" className="text-brand text-xs font-medium hover:underline">
              Esqueci minha senha
            </Link>
          </div>
        </div>

        <Button type="submit" className="w-full" loading={isSubmitting} disabled={locked}>
          Entrar
        </Button>
      </form>

      <p className="text-muted mt-6 text-center text-sm">
        Não tem conta?{' '}
        <Link to="/cadastro" className="text-brand font-medium hover:underline">
          Criar conta
        </Link>
      </p>
    </>
  );
}
