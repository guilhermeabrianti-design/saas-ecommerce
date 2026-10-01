import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { MailCheck } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { isValidCode, normalizeCode, rememberReferralCode } from '@/features/affiliates/affiliates';
import { useInvitePreview } from '@/features/organizations/api';
import { isInviteToken, rememberInviteToken } from '@/features/organizations/invite';
import { orgRoleLabels } from '@/features/organizations/roles';
import { getSupabase } from '@/lib/supabase';
import { onlyDigits } from '@/utils/br';
import { cn } from '@/utils/cn';
import { AuthHeading } from '../components/AuthHeading';
import { PasswordRules } from '../components/PasswordRules';
import { authErrorMessage } from '../errors';
import { authRedirectUrl } from '../redirect';
import { roleLabels, signUpRoles, type SignUpRole } from '../roles';
import { signUpSchema, type SignUpValues } from '../schemas';

const roleDescriptions: Record<SignUpRole, string> = {
  seller: 'Vendo em marketplaces e lojas virtuais.',
  supplier: 'Forneço produtos para vendedores.',
};

export function SignUpPage() {
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  // Link de indicação (/cadastro?indicacao=código): usado ao criar a organização.
  const [params] = useSearchParams();
  const rawReferral = params.get('indicacao') ?? '';
  const referral = isValidCode(rawReferral) ? normalizeCode(rawReferral) : null;
  useEffect(() => {
    if (referral) rememberReferralCode(referral);
  }, [referral]);
  // Link de convite (/convite/<token> → /cadastro?convite=<token>): a conta nasce na empresa.
  const rawInvite = params.get('convite');
  const inviteToken = isInviteToken(rawInvite) ? rawInvite : '';
  const invite = useInvitePreview(inviteToken);
  const invited = invite.data ?? null;
  useEffect(() => {
    if (inviteToken) rememberInviteToken(inviteToken);
  }, [inviteToken]);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<SignUpValues>({
    resolver: zodResolver(signUpSchema),
    defaultValues: {
      fullName: '',
      email: '',
      phone: '',
      document: '',
      password: '',
      confirmPassword: '',
      // /cadastro?conta=fornecedor (landing page) já marca fornecedor.
      accountType: params.get('conta') === 'fornecedor' ? 'supplier' : 'seller',
    },
  });
  const password = useWatch({ control, name: 'password' });
  const accountType = useWatch({ control, name: 'accountType' });
  // Convite: o tipo de conta é o da empresa.
  useEffect(() => {
    if (invited) setValue('accountType', invited.kind);
  }, [invited, setValue]);

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    const { error: signUpError } = await getSupabase().auth.signUp({
      email: values.email,
      password: values.password,
      options: {
        // Read by the `handle_new_user` trigger, which only accepts seller|supplier.
        // phone/document are re-validated there; an invalid value is dropped, never trusted.
        data: {
          full_name: values.fullName,
          account_type: values.accountType,
          phone: onlyDigits(values.phone),
          document: onlyDigits(values.document),
        },
        emailRedirectTo: authRedirectUrl('/entrar'),
      },
    });
    if (signUpError) {
      setError(authErrorMessage(signUpError));
      return;
    }
    // Shown whether or not the e-mail was already registered (Supabase answers
    // identically), so the form cannot be used to discover existing accounts.
    setSentTo(values.email);
  });

  if (sentTo) {
    return (
      <div className="text-center">
        <MailCheck className="text-brand mx-auto size-10" aria-hidden />
        <h1 className="mt-4 text-xl font-semibold tracking-tight">Confirme seu e-mail</h1>
        <p className="text-muted mt-2 text-sm">
          Enviamos um link de confirmação para <strong className="text-fg">{sentTo}</strong>. Abra-o
          neste navegador para ativar sua conta.
        </p>
        <Link
          to="/entrar"
          className="text-brand mt-6 inline-block text-sm font-medium hover:underline"
        >
          Ir para o login
        </Link>
      </div>
    );
  }

  return (
    <>
      <AuthHeading title="Criar conta">Comece a usar a TheSigns.</AuthHeading>

      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        {invited && (
          <Alert tone="info">
            Convite para <strong>{invited.organization_name}</strong> como{' '}
            {orgRoleLabels[invited.role]}. Ao entrar, você já estará na equipe.
          </Alert>
        )}
        {inviteToken && invite.isSuccess && !invited && (
          <Alert tone="error">
            Este link de convite não vale mais. Peça um novo a quem convidou você.
          </Alert>
        )}
        {referral && !invited && (
          <Alert tone="info">
            Você chegou por uma indicação (código {referral}). Ela será registrada na sua conta.
          </Alert>
        )}

        <fieldset hidden={!!invited}>
          <legend className="mb-1.5 text-sm font-medium">Tipo de conta</legend>
          <div className="grid grid-cols-2 gap-2">
            {signUpRoles.map((role) => (
              <label
                key={role}
                className={cn(
                  'border-border hover:bg-surface-2 has-[:focus-visible]:ring-brand/40 cursor-pointer rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2',
                  accountType === role && 'border-brand bg-brand/5 hover:bg-brand/5',
                )}
              >
                <input type="radio" value={role} className="sr-only" {...register('accountType')} />
                <span className="block text-sm font-medium">{roleLabels[role]}</span>
                <span className="text-muted mt-0.5 block text-xs">{roleDescriptions[role]}</span>
              </label>
            ))}
          </div>
          {errors.accountType && (
            <p className="text-danger mt-1.5 text-xs">{errors.accountType.message}</p>
          )}
        </fieldset>

        <TextField
          label="Nome completo"
          autoComplete="name"
          error={errors.fullName?.message}
          {...register('fullName')}
        />
        <TextField
          label="E-mail"
          type="email"
          autoComplete="email"
          inputMode="email"
          error={errors.email?.message}
          {...register('email')}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Telefone"
            type="tel"
            autoComplete="tel-national"
            inputMode="tel"
            placeholder="(11) 91234-5678"
            error={errors.phone?.message}
            {...register('phone')}
          />
          <TextField
            label="CPF ou CNPJ"
            inputMode="numeric"
            error={errors.document?.message}
            {...register('document')}
          />
        </div>
        <TextField
          label="Senha"
          type="password"
          autoComplete="new-password"
          error={errors.password?.message}
          hint={<PasswordRules value={password} />}
          {...register('password')}
        />
        <TextField
          label="Confirmar senha"
          type="password"
          autoComplete="new-password"
          error={errors.confirmPassword?.message}
          {...register('confirmPassword')}
        />

        <Button type="submit" className="w-full" loading={isSubmitting}>
          Criar conta
        </Button>
      </form>

      <p className="text-muted mt-6 text-center text-sm">
        Já tem conta?{' '}
        <Link to="/entrar" className="text-brand font-medium hover:underline">
          Entrar
        </Link>
      </p>
    </>
  );
}
