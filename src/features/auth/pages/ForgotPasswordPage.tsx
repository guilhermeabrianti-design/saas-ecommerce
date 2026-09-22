import { useState } from 'react';
import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { getSupabase } from '@/lib/supabase';
import { AuthHeading } from '../components/AuthHeading';
import { authErrorMessage } from '../errors';
import { authRedirectUrl } from '../redirect';
import { forgotPasswordSchema, type ForgotPasswordValues } from '../schemas';

export function ForgotPasswordPage() {
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });

  const onSubmit = handleSubmit(async ({ email }) => {
    setError(null);
    const { error: resetError } = await getSupabase().auth.resetPasswordForEmail(email, {
      redirectTo: authRedirectUrl('/redefinir-senha'),
    });
    if (resetError) {
      setError(authErrorMessage(resetError));
      return;
    }
    setSent(true);
  });

  return (
    <>
      <AuthHeading title="Recuperar senha">
        Informe seu e-mail e enviaremos um link para criar uma nova senha.
      </AuthHeading>

      {sent ? (
        // Same message whether or not the account exists (no account enumeration).
        <Alert tone="success">
          Se houver uma conta com esse e-mail, você receberá um link em instantes. Abra-o neste
          navegador.
        </Alert>
      ) : (
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {error && <Alert tone="error">{error}</Alert>}
          <TextField
            label="E-mail"
            type="email"
            autoComplete="email"
            inputMode="email"
            autoFocus
            error={errors.email?.message}
            {...register('email')}
          />
          <Button type="submit" className="w-full" loading={isSubmitting}>
            Enviar link
          </Button>
        </form>
      )}

      <p className="text-muted mt-6 text-center text-sm">
        <Link to="/entrar" className="text-brand font-medium hover:underline">
          Voltar ao login
        </Link>
      </p>
    </>
  );
}
