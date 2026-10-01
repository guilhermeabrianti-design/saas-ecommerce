import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { CopyField } from '@/components/ui/CopyField';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { useAuth } from '@/features/auth/auth-context';
import {
  useCreateInviteLink,
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
import { inviteUrl } from '../invite';
import { organizationFormSchema, type OrganizationFormValues } from '../schemas';

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
    <Section title="Dados" description="Identificação da empresa na TheSigns.">
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
    <Section title="Membros" description="Pessoas com acesso aos dados desta empresa.">
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
  const create = useCreateInviteLink(organization.id);
  const revoke = useRevokeInvitation(organization.id);
  const invitable = orgPermissions.invitableRoles(role);
  const [newRole, setNewRole] = useState<OrgRole>('member');
  const [label, setLabel] = useState('');
  // Captured once per mount: enough to flag links that already expired.
  const [now] = useState(() => Date.now());
  const origin = window.location.origin;
  const links = (invitations.data ?? []).filter((i) => i.token);

  return (
    <Section
      title="Convidar para a equipe"
      description="Gere um link com o nível de acesso e envie para a pessoa. Quem abrir o link cria a conta e já entra na sua empresa. Cada link vale para uma pessoa, por 7 dias."
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({ role: newRole, label }, { onSuccess: () => setLabel('') });
        }}
      >
        {create.isError && <Alert tone="error">{orgErrorMessage(create.error)}</Alert>}
        <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
          <TextField
            label="Para quem (opcional)"
            placeholder="Ex.: Ana do estoque"
            maxLength={60}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Select
            label="Acesso"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as OrgRole)}
          >
            {invitable.map((r) => (
              <option key={r} value={r}>
                {orgRoleLabels[r]}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" loading={create.isPending}>
          <Plus className="size-4" aria-hidden />
          Gerar link de convite
        </Button>
        {create.data && (
          <div className="space-y-2">
            <Alert tone="success">Link pronto. Copie e envie para a pessoa.</Alert>
            <CopyField value={inviteUrl(origin, create.data)} label="Link de convite" />
          </div>
        )}
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
        ) : links.length === 0 ? (
          <p className="text-muted text-sm">Nenhum link de convite em aberto.</p>
        ) : (
          <ul className="divide-border divide-y">
            {links.map((inv) => {
              const expired = new Date(inv.expires_at).getTime() <= now;
              return (
                <li key={inv.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1 text-sm">
                      <p className="truncate font-medium">{inv.label ?? 'Convite sem nome'}</p>
                      <p className={expired ? 'text-danger' : 'text-muted'}>
                        {orgRoleLabels[inv.role]} ·{' '}
                        {expired ? 'vencido' : `vale até ${formatDate(inv.expires_at)}`}
                      </p>
                    </div>
                    <ConfirmButton
                      confirmLabel="Cancelar link"
                      loading={revoke.isPending && revoke.variables === inv.id}
                      onConfirm={() => revoke.mutate(inv.id)}
                    >
                      Cancelar
                    </ConfirmButton>
                  </div>
                  {!expired && (
                    <CopyField value={inviteUrl(origin, inv.token!)} label="Link de convite" />
                  )}
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
      title="Sair da empresa"
      description="Você perde o acesso aos dados desta empresa imediatamente."
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
        Sair da empresa
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
          <h1 className="text-2xl font-semibold tracking-tight">Empresa</h1>
          <p className="text-muted mt-1 text-sm">{active.organization.name}</p>
        </div>
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
