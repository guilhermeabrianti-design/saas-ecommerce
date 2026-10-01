import { useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { TextField } from '@/components/ui/TextField';
import { clearReferralCode, pendingReferralCode } from '@/features/affiliates/affiliates';
import { useReferralSettings } from '@/features/affiliates/api';
import { useProfile } from '@/features/auth/profile';
import { useCreateOrganization } from '../api';
import { PendingInvitations } from '../components/PendingInvitations';
import { orgErrorMessage } from '../errors';
import { useOrganization } from '../organization-context';
import { orgKindLabels } from '../roles';
import { createOrganizationFormSchema, type CreateOrganizationFormValues } from '../schemas';

export function CreateOrganizationPage() {
  const profile = useProfile();
  const { memberships, selectOrganization } = useOrganization();
  const create = useCreateOrganization();
  // Só vendedores; com o programa pausado o campo some e o código guardado não é enviado.
  const referralEnabled =
    useReferralSettings().data?.enabled === true && profile.data?.role === 'seller';
  const navigate = useNavigate();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateOrganizationFormValues>({
    resolver: zodResolver(createOrganizationFormSchema),
    // Código guardado pelo link de indicação (/cadastro?indicacao=…).
    defaultValues: { name: '', referral_code: pendingReferralCode() ?? '' },
  });

  if (profile.isPending) return <PageLoader />;
  if (profile.isError) {
    return <Alert tone="error">Não foi possível carregar seu perfil. Recarregue a página.</Alert>;
  }

  const role = profile.data.role;
  const firstTime = memberships.length === 0;

  const onSubmit = handleSubmit(({ name, referral_code }) => {
    create.mutate(
      { name, referralCode: referralEnabled ? referral_code : null },
      {
        onSuccess: (orgId) => {
          clearReferralCode();
          selectOrganization(orgId);
          void navigate('/');
        },
      },
    );
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {firstTime ? 'Configure sua organização' : 'Nova organização'}
        </h1>
        <p className="text-muted mt-1 text-sm">
          Produtos, pedidos, estoque e integrações pertencem a uma organização. Crie a sua ou aceite
          um convite de uma organização existente.
        </p>
      </div>

      <PendingInvitations />

      {role === 'admin' ? (
        <Alert tone="info">Contas da equipe TheSigns não criam organizações de clientes.</Alert>
      ) : (
        <Section
          title="Criar organização"
          description={`Organização de ${orgKindLabels[role].toLowerCase()}, o mesmo tipo da sua conta. Você será o proprietário.`}
        >
          <form onSubmit={onSubmit} noValidate className="space-y-4">
            {create.isError && <Alert tone="error">{orgErrorMessage(create.error)}</Alert>}
            <TextField
              label="Nome da organização"
              placeholder="Ex.: Loja da Ana"
              autoComplete="organization"
              error={errors.name?.message}
              {...register('name')}
            />
            {referralEnabled && (
              <TextField
                label="Código de indicação (opcional)"
                placeholder="Quem convidou você para a TheSigns"
                autoComplete="off"
                error={errors.referral_code?.message}
                {...register('referral_code')}
              />
            )}
            <Button type="submit" loading={create.isPending}>
              Criar organização
            </Button>
          </form>
        </Section>
      )}
    </div>
  );
}
