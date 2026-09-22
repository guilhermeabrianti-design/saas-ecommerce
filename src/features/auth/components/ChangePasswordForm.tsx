import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { isAuthError } from '@supabase/supabase-js';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { getSupabase } from '@/lib/supabase';
import { authErrorMessage } from '../errors';
import { newPasswordSchema, type NewPasswordValues } from '../schemas';
import { PasswordRules } from './PasswordRules';

const REAUTH_CODES = new Set(['reauthentication_needed', 'reauth_nonce_missing']);

/**
 * Sets a new password for the signed-in user. With `secure_password_change`
 * enabled, sessions older than 24h must confirm with a code sent by e-mail.
 */
export function ChangePasswordForm({
  submitLabel = 'Salvar nova senha',
  onSuccess,
}: {
  submitLabel?: string;
  onSuccess: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [nonceRequested, setNonceRequested] = useState(false);
  const [nonce, setNonce] = useState('');

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<NewPasswordValues>({
    resolver: zodResolver(newPasswordSchema),
    defaultValues: { password: '', confirmPassword: '' },
  });
  const password = useWatch({ control, name: 'password' });

  const onSubmit = handleSubmit(async ({ password: newPassword }) => {
    setError(null);
    if (nonceRequested && !nonce.trim()) {
      setError('Informe o código enviado para seu e-mail.');
      return;
    }

    const auth = getSupabase().auth;
    const { error: updateError } = await auth.updateUser(
      nonceRequested ? { password: newPassword, nonce: nonce.trim() } : { password: newPassword },
    );

    if (updateError) {
      if (isAuthError(updateError) && updateError.code && REAUTH_CODES.has(updateError.code)) {
        const { error: reauthError } = await auth.reauthenticate();
        if (reauthError) setError(authErrorMessage(reauthError));
        else setNonceRequested(true);
        return;
      }
      setError(authErrorMessage(updateError));
      return;
    }

    reset();
    setNonce('');
    setNonceRequested(false);
    onSuccess();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {error && <Alert tone="error">{error}</Alert>}
      <TextField
        label="Nova senha"
        type="password"
        autoComplete="new-password"
        error={errors.password?.message}
        hint={<PasswordRules value={password} />}
        {...register('password')}
      />
      <TextField
        label="Confirmar nova senha"
        type="password"
        autoComplete="new-password"
        error={errors.confirmPassword?.message}
        {...register('confirmPassword')}
      />
      {nonceRequested && (
        <>
          <Alert tone="info">
            Por segurança, enviamos um código para seu e-mail. Informe-o para confirmar a troca.
          </Alert>
          <TextField
            label="Código de verificação"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={nonce}
            onChange={(e) => setNonce(e.target.value)}
          />
        </>
      )}
      <Button type="submit" loading={isSubmitting}>
        {submitLabel}
      </Button>
    </form>
  );
}
