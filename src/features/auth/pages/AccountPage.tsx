import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { LogOut } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { TextField } from '@/components/ui/TextField';
import { useAuth } from '../auth-context';
import { ChangePasswordForm } from '../components/ChangePasswordForm';
import { useProfile, useUpdateFullName, type Profile } from '../profile';
import { roleLabels } from '../roles';
import { profileFormSchema, type ProfileFormValues } from '../schemas';

function ProfileForm({ profile, email }: { profile: Profile; email: string }) {
  const update = useUpdateFullName();
  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
    reset,
  } = useForm<ProfileFormValues>({
    resolver: zodResolver(profileFormSchema),
    defaultValues: { fullName: profile.full_name },
  });

  const onSubmit = handleSubmit(({ fullName }) => {
    update.mutate(fullName, { onSuccess: () => reset({ fullName }) });
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {update.isError && <Alert tone="error">Não foi possível salvar. Tente novamente.</Alert>}
      {update.isSuccess && !isDirty && <Alert tone="success">Perfil atualizado.</Alert>}
      <TextField
        label="Nome completo"
        autoComplete="name"
        error={errors.fullName?.message}
        {...register('fullName')}
      />
      <TextField label="E-mail" value={email} disabled readOnly />
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted">Tipo de conta</dt>
          <dd className="font-medium">{roleLabels[profile.role]}</dd>
        </div>
        <div>
          <dt className="text-muted">Membro desde</dt>
          <dd className="font-medium">
            {new Date(profile.created_at).toLocaleDateString('pt-BR')}
          </dd>
        </div>
      </dl>
      <Button type="submit" loading={update.isPending} disabled={!isDirty}>
        Salvar
      </Button>
    </form>
  );
}

export function AccountPage() {
  const { user, signOut } = useAuth();
  const profile = useProfile();
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Minha conta</h1>
        <p className="text-muted mt-1 text-sm">Dados de acesso e perfil.</p>
      </div>

      <Section title="Perfil" description="Como você aparece na TheSigns.">
        {profile.isPending ? (
          <PageLoader />
        ) : profile.isError ? (
          <Alert tone="error">Não foi possível carregar seu perfil. Recarregue a página.</Alert>
        ) : (
          <ProfileForm profile={profile.data} email={user?.email ?? ''} />
        )}
      </Section>

      <Section title="Senha" description="Troque a senha usada para entrar.">
        {passwordChanged && (
          <Alert tone="success" className="mb-4">
            Senha alterada com sucesso.
          </Alert>
        )}
        <ChangePasswordForm onSuccess={() => setPasswordChanged(true)} />
      </Section>

      <Section title="Sessão" description="Encerre o acesso neste dispositivo.">
        <Button
          variant="secondary"
          loading={signingOut}
          onClick={async () => {
            setSigningOut(true);
            await signOut();
          }}
        >
          <LogOut className="size-4" aria-hidden />
          Sair
        </Button>
      </Section>
    </div>
  );
}
