import { useForm, useWatch } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { zodResolver } from '@hookform/resolvers/zod';
import { ChevronRight } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { useOrganization } from '@/features/organizations/organization-context';
import { orgPermissions } from '@/features/organizations/roles';
import { integrationErrorMessage, useConnections, useCreateConnection } from '../api';
import { ConnectionStatusBadge } from '../components/ConnectionStatusBadge';
import {
  accountHints,
  connectableProviders,
  connectionFormSchema,
  emptyConnectionForm,
  generateSecret,
  providerLabels,
  providers,
  type ConnectionFormValues,
} from '../schemas';

function NewConnectionForm({ orgId }: { orgId: string }) {
  const navigate = useNavigate();
  const create = useCreateConnection(orgId);
  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors },
  } = useForm<ConnectionFormValues>({
    resolver: zodResolver(connectionFormSchema),
    defaultValues: emptyConnectionForm,
  });
  const provider = useWatch({ control, name: 'provider' });
  const hint = accountHints[provider];

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={handleSubmit((v) =>
        create.mutate(v, { onSuccess: (id) => navigate(`/integracoes/${id}`) }),
      )}
    >
      {create.isError && <Alert tone="error">{integrationErrorMessage(create.error)}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="Marketplace" {...register('provider')}>
          {connectableProviders.map((p) => (
            <option key={p} value={p}>
              {providerLabels[p]}
            </option>
          ))}
        </Select>
        <TextField
          label="Nome da conexão"
          placeholder="Ex.: Loja principal"
          error={errors.name?.message}
          {...register('name')}
        />
      </div>
      <TextField
        label={hint.label}
        placeholder={hint.placeholder}
        autoComplete="off"
        error={errors.externalAccountId?.message}
        {...register('externalAccountId')}
      />
      <div className="space-y-2">
        <TextField
          label="Segredo do webhook"
          className="font-mono"
          autoComplete="off"
          error={errors.secret?.message}
          hint={
            provider === 'shopify'
              ? 'Copie o segredo de assinatura que a Shopify mostra na página de webhooks.'
              : 'Você define o segredo; use o mesmo valor no WooCommerce.'
          }
          {...register('secret')}
        />
        {provider === 'woocommerce' && (
          <Button
            variant="ghost"
            onClick={() => setValue('secret', generateSecret(), { shouldValidate: true })}
          >
            Gerar segredo aleatório
          </Button>
        )}
      </div>
      <Button type="submit" loading={create.isPending}>
        Criar conexão
      </Button>
    </form>
  );
}

export function IntegrationsPage() {
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const connections = useConnections(orgId);

  if (!orgPermissions.manageIntegrations(active!.role)) {
    return (
      <div className="mx-auto max-w-3xl">
        <Alert tone="info">
          As integrações são gerenciadas por proprietários e administradores.
        </Alert>
      </div>
    );
  }

  const soon = providers.filter((p) => !(connectableProviders as readonly string[]).includes(p));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Integrações</h1>
        <p className="text-muted text-sm">
          Receba pedidos dos seus marketplaces como pedidos pendentes e mantenha o estoque em dia.
        </p>
      </div>

      <Section
        title="Conexões"
        description="Cada conexão tem sua própria URL de webhook e segredo."
      >
        {connections.isPending ? (
          <PageLoader />
        ) : connections.isError ? (
          <Alert tone="error">{integrationErrorMessage(connections.error)}</Alert>
        ) : connections.data.length === 0 ? (
          <p className="text-muted text-sm">Nenhuma conexão ainda. Crie a primeira abaixo.</p>
        ) : (
          <ul className="divide-border -my-3 divide-y text-sm">
            {connections.data.map((c) => (
              <li key={c.id}>
                <Link
                  to={`/integracoes/${c.id}`}
                  className="hover:bg-surface-2 -mx-2 flex items-center gap-3 rounded-lg px-2 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{c.name}</p>
                    <p className="text-muted truncate text-xs">
                      {providerLabels[c.provider]} · {c.external_account_id}
                    </p>
                  </div>
                  <ConnectionStatusBadge status={c.status} />
                  <ChevronRight className="text-muted size-4" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Nova conexão" description="Shopify e WooCommerce, via webhook de pedidos.">
        <NewConnectionForm orgId={orgId} />
      </Section>

      <p className="text-muted text-sm">
        Em breve: {soon.map((p) => providerLabels[p]).join(', ')}.
      </p>
    </div>
  );
}
