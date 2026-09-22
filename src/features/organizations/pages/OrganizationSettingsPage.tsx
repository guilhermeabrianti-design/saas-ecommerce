import { useState } from 'react';
import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { useAuth } from '@/features/auth/auth-context';
import {
  useInviteMember,
  useOrganizationInvitations,
  useOrganizationMembers,
  useRemoveMember,
  useRenameOrganization,
  useRevokeInvitation,
  useUpdateMemberRole,
  type Membership,
} from '../api';
import { orgErrorMessage } from '../errors';
import { useOrganization } from '../organization-context';
import { orgKindLabels, orgPermissions, orgRoleLabels, orgRoles, type OrgRole } from '../roles';
import {
  inviteFormSchema,
  organizationFormSchema,
  type InviteFormValues,
  type OrganizationFormValues,
} from '../schemas';

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

function DetailsSection({ membership }: { membership: Membership }) {
  const { organization, role } = membership;
  const rename = useRenameOrganization(organization.id);
  const canRename = orgPermissions.rename(role);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<OrganizationFormValues>({
    resolver: zodResolver(organizationFormSchema),
    values: { name: organization.name },
  });

  const onSubmit = handleSubmit(({ name }) => {
    rename.mutate(name, { onSuccess: () => reset({ name }) });
  });

  return (
    <Section title="Dados" description="Identificação da organização na TheSigns.">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {rename.isError && <Alert tone="error">{orgErrorMessage(rename.error)}</Alert>}
        {rename.isSuccess && !isDirty && <Alert tone="success">Nome atualizado.</Alert>}
        <TextField
          label="Nome"
          disabled={!canRename}
          error={errors.name?.message}
          {...register('name')}
        />
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted">Tipo</dt>
            <dd className="font-medium">{orgKindLabels[organization.kind]}</dd>
          </div>
          <div>
            <dt className="text-muted">Seu papel</dt>
            <dd className="font-medium">{orgRoleLabels[role]}</dd>
          </div>
        </dl>
        {canRename && (
          <Button type="submit" loading={rename.isPending} disabled={!isDirty}>
            Salvar
          </Button>
        )}
      </form>
    </Section>
  );
}

function MembersSection({ membership }: { membership: Membership }) {
  const { organization, role: myRole } = membership;
  const { user } = useAuth();
  const members = useOrganizationMembers(organization.id);
  const updateRole = useUpdateMemberRole(organization.id);
  const remove = useRemoveMember(organization.id);
  const error = updateRole.error ?? remove.error;

  return (
    <Section title="Membros" description="Pessoas com acesso aos dados desta organização.">
      {error && (
        <Alert tone="error" className="mb-4">
          {orgErrorMessage(error)}
        </Alert>
      )}
      {members.isPending ? (
        <PageLoader />
      ) : members.isError ? (
        <Alert tone="error">Não foi possível carregar os membros.</Alert>
      ) : (
        <ul className="divide-border -my-3 divide-y">
          {members.data.map((m) => {
            const isMe = m.user_id === user?.id;
            return (
              <li key={m.user_id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1 text-sm">
                  <p className="truncate font-medium">
                    {m.full_name}
                    {isMe && <span className="text-muted font-normal"> (você)</span>}
                  </p>
                  <p className="text-muted truncate">
                    {m.email} · desde {formatDate(m.joined_at)}
                  </p>
                </div>
                {orgPermissions.changeRoles(myRole) ? (
                  <Select
                    aria-label={`Papel de ${m.full_name}`}
                    value={m.role}
                    disabled={updateRole.isPending}
                    onChange={(e) =>
                      updateRole.mutate({ userId: m.user_id, role: e.target.value as OrgRole })
                    }
                  >
                    {orgRoles.map((r) => (
                      <option key={r} value={r}>
                        {orgRoleLabels[r]}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span className="text-muted text-sm">{orgRoleLabels[m.role]}</span>
                )}
                {!isMe && orgPermissions.removeMember(myRole, m.role) && (
                  <ConfirmButton
                    confirmLabel="Remover"
                    loading={remove.isPending && remove.variables === m.user_id}
                    onConfirm={() => remove.mutate(m.user_id)}
                  >
                    Remover
                  </ConfirmButton>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function InvitationsSection({ membership }: { membership: Membership }) {
  const { organization, role } = membership;
  const invitations = useOrganizationInvitations(organization.id);
  const inviteMember = useInviteMember(organization.id);
  const revoke = useRevokeInvitation(organization.id);
  const invitable = orgPermissions.invitableRoles(role);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<InviteFormValues>({
    resolver: zodResolver(inviteFormSchema),
    defaultValues: { email: '', role: 'member' },
  });

  const onSubmit = handleSubmit((values) => {
    inviteMember.mutate(values, { onSuccess: () => reset({ email: '', role: values.role }) });
  });

  // Captured once per mount: enough to flag invitations that already expired.
  const [now] = useState(() => Date.now());

  return (
    <Section
      title="Convites"
      description="O convidado vê o convite ao entrar na TheSigns com este e-mail. Convites valem por 7 dias."
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {inviteMember.isError && <Alert tone="error">{orgErrorMessage(inviteMember.error)}</Alert>}
        {inviteMember.isSuccess && <Alert tone="success">Convite registrado.</Alert>}
        <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
          <TextField
            label="E-mail"
            type="email"
            autoComplete="off"
            error={errors.email?.message}
            {...register('email')}
          />
          <Select label="Papel" {...register('role')}>
            {invitable.map((r) => (
              <option key={r} value={r}>
                {orgRoleLabels[r]}
              </option>
            ))}
          </Select>
        </div>
        <Alert tone="info">
          O envio automático de e-mail de convite ainda não está disponível. Avise a pessoa para
          entrar (ou criar a conta) com o e-mail convidado.
        </Alert>
        <Button type="submit" loading={inviteMember.isPending}>
          <Plus className="size-4" aria-hidden />
          Convidar
        </Button>
      </form>

      <div className="border-border mt-6 border-t pt-4">
        {revoke.isError && (
          <Alert tone="error" className="mb-3">
            {orgErrorMessage(revoke.error)}
          </Alert>
        )}
        {invitations.isPending ? (
          <PageLoader />
        ) : invitations.isError ? (
          <Alert tone="error">Não foi possível carregar os convites.</Alert>
        ) : invitations.data.length === 0 ? (
          <p className="text-muted text-sm">Nenhum convite pendente.</p>
        ) : (
          <ul className="divide-border divide-y">
            {invitations.data.map((inv) => {
              const expired = new Date(inv.expires_at).getTime() <= now;
              return (
                <li key={inv.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="truncate font-medium">{inv.email}</p>
                    <p className={expired ? 'text-danger' : 'text-muted'}>
                      {orgRoleLabels[inv.role]} ·{' '}
                      {expired ? 'expirado' : `expira em ${formatDate(inv.expires_at)}`}
                    </p>
                  </div>
                  <ConfirmButton
                    confirmLabel="Revogar"
                    loading={revoke.isPending && revoke.variables === inv.id}
                    onConfirm={() => revoke.mutate(inv.id)}
                  >
                    Revogar
                  </ConfirmButton>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Section>
  );
}

function LeaveSection({ membership }: { membership: Membership }) {
  const { user } = useAuth();
  const leave = useRemoveMember(membership.organization.id);

  return (
    <Section
      title="Sair da organização"
      description="Você perde o acesso aos dados desta organização imediatamente."
    >
      {leave.isError && (
        <Alert tone="error" className="mb-4">
          {orgErrorMessage(leave.error)}
        </Alert>
      )}
      <ConfirmButton
        confirmLabel="Sair definitivamente"
        loading={leave.isPending}
        onConfirm={() => user && leave.mutate(user.id)}
      >
        Sair da organização
      </ConfirmButton>
    </Section>
  );
}

export function OrganizationSettingsPage() {
  const { active } = useOrganization();
  // RequireOrganization guarantees an active organization.
  if (!active) return null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Organização</h1>
          <p className="text-muted mt-1 text-sm">{active.organization.name}</p>
        </div>
        <Link to="/organizacao/nova" className="text-brand text-sm font-medium hover:underline">
          Criar ou entrar em outra
        </Link>
      </div>

      {/* Keyed so switching organizations never shows the previous one's form state. */}
      <div key={active.organization.id} className="space-y-6">
        <DetailsSection membership={active} />
        <MembersSection membership={active} />
        {orgPermissions.manageInvitations(active.role) && (
          <InvitationsSection membership={active} />
        )}
        <LeaveSection membership={active} />
      </div>
    </div>
  );
}
