import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useParams, useSearchParams } from 'react-router';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { CopyField } from '@/components/ui/CopyField';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { useOrganization } from '@/features/organizations/organization-context';
import { orgPermissions } from '@/features/organizations/roles';
import { describeAttributes } from '@/features/products/variants';
import { env } from '@/lib/env';
import { cn } from '@/utils/cn';
import {
  integrationErrorMessage,
  retryMessages,
  useConnection,
  useIntegrationEvents,
  useLinkListing,
  useListingLinks,
  useRetryEvent,
  useRotateSecret,
  useSellableItems,
  useSetConnectionStatus,
  useSetAutoForward,
  useUnlinkListing,
  type Connection,
  type IntegrationEvent,
} from '../api';
import { ConnectionStatusBadge } from '../components/ConnectionStatusBadge';
import { CredentialsSection } from '../components/CredentialsSection';
import { MercadoLivreConnect } from '../components/MercadoLivreConnect';
import { mercadoLivreReturnMessages } from '../mercadolivre';
import {
  connectableProviders,
  generateSecret,
  linkFormSchema,
  providerLabels,
  webhookInstructions,
  webhookUrl,
  type ConnectableProvider,
  type LinkFormValues,
} from '../schemas';

const when = (iso: string) => new Date(iso).toLocaleString('pt-BR');

function isConnectable(p: string): p is ConnectableProvider {
  return (connectableProviders as readonly string[]).includes(p);
}

/** Liga/desliga o envio automático do pedido pago ao fornecedor. */
function AutoForwardToggle({ connection }: { connection: Connection }) {
  const { active } = useOrganization();
  const set = useSetAutoForward(active!.organization.id, connection.id);
  return (
    <div className="space-y-2">
      {set.isError && <Alert tone="error">{integrationErrorMessage(set.error)}</Alert>}
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 size-4"
          checked={set.isPending ? set.variables : connection.auto_forward}
          disabled={set.isPending}
          onChange={(e) => set.mutate(e.target.checked)}
        />
        <span>
          <span className="font-medium">Enviar pedidos pagos direto ao fornecedor</span>
          <span className="text-muted block">
            Confirma o pedido sozinho e cria o pedido de fornecimento. Se faltar estoque, ele fica
            pendente e você é avisado.
          </span>
        </span>
      </label>
    </div>
  );
}

function Status({ connection }: { connection: Connection }) {
  const { active } = useOrganization();
  const set = useSetConnectionStatus(active!.organization.id, connection.id);
  const busy = (s: string) => set.isPending && set.variables === s;

  return (
    <div className="space-y-3">
      {set.isError && <Alert tone="error">{integrationErrorMessage(set.error)}</Alert>}
      <div className="flex flex-wrap gap-2">
        {connection.status === 'active' && (
          <Button variant="secondary" loading={busy('paused')} onClick={() => set.mutate('paused')}>
            Pausar
          </Button>
        )}
        {connection.status === 'paused' && (
          <Button loading={busy('active')} onClick={() => set.mutate('active')}>
            Retomar
          </Button>
        )}
        {connection.status !== 'disconnected' && (
          <ConfirmButton
            confirmLabel="Desconectar de vez"
            loading={busy('disconnected')}
            onConfirm={() => set.mutate('disconnected')}
          >
            Desconectar
          </ConfirmButton>
        )}
      </div>
      {connection.status === 'paused' && (
        <p className="text-muted text-sm">
          Pausada: pedidos recebidos são ignorados e o estoque não é enviado.
        </p>
      )}
    </div>
  );
}

function RotateSecret({ connection }: { connection: Connection }) {
  const rotate = useRotateSecret(connection.id);
  const [secret, setSecret] = useState('');
  const valid = secret.trim().length >= 16;

  return (
    <form
      noValidate
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) rotate.mutate(secret.trim(), { onSuccess: () => setSecret('') });
      }}
    >
      <TextField
        label="Trocar segredo do webhook"
        className="font-mono"
        autoComplete="off"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        error={secret && !valid ? 'Ao menos 16 caracteres' : undefined}
        hint="O segredo atual nunca é exibido. Atualize o mesmo valor no marketplace."
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="secondary" loading={rotate.isPending} disabled={!valid}>
          Salvar segredo
        </Button>
        {connection.provider === 'woocommerce' && (
          <Button variant="ghost" onClick={() => setSecret(generateSecret())}>
            Gerar aleatório
          </Button>
        )}
      </div>
      {rotate.isError && <Alert tone="error">{integrationErrorMessage(rotate.error)}</Alert>}
      {rotate.isSuccess && <Alert tone="success">Segredo atualizado.</Alert>}
    </form>
  );
}

function Links({ connection, canEdit }: { connection: Connection; canEdit: boolean }) {
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const links = useListingLinks(orgId, connection.id);
  const items = useSellableItems(orgId);
  const link = useLinkListing(orgId, connection.id);
  const unlink = useUnlinkListing(orgId);
  const disconnected = connection.status === 'disconnected';

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<LinkFormValues>({
    resolver: zodResolver(linkFormSchema),
    defaultValues: { inventoryItemId: '', externalId: '', syncStock: true },
  });

  return (
    <div className="space-y-5">
      {links.isPending ? (
        <PageLoader />
      ) : links.isError ? (
        <Alert tone="error">{integrationErrorMessage(links.error)}</Alert>
      ) : links.data.length === 0 ? (
        <p className="text-muted text-sm">
          Nenhum vínculo. Sem vínculo, pedidos com esse SKU ficam parados na atividade.
        </p>
      ) : (
        <ul className="divide-border -my-3 divide-y text-sm">
          {links.data.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  <span className="font-mono">{l.external_id}</span>
                  <span className="text-muted"> → </span>
                  {l.item ? l.item.product_name : 'Item removido'}
                </p>
                {l.item && (
                  <p className="text-muted truncate text-xs">
                    <span className="font-mono">{l.item.sku}</span>
                    {l.item.attributes && ` · ${describeAttributes(l.item.attributes)}`} ·{' '}
                    {l.item.available} disponíveis
                    {l.sync_stock
                      ? l.last_pushed_at
                        ? ` · último envio: ${l.last_pushed_available} (${when(l.last_pushed_at)})`
                        : ' · estoque ainda não enviado'
                      : ' · sem envio de estoque'}
                  </p>
                )}
              </div>
              {canEdit && (
                <ConfirmButton
                  confirmLabel="Remover vínculo"
                  loading={unlink.isPending && unlink.variables === l.id}
                  onConfirm={() => unlink.mutate(l.id)}
                >
                  Desvincular
                </ConfirmButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {unlink.isError && <Alert tone="error">{integrationErrorMessage(unlink.error)}</Alert>}

      {canEdit && !disconnected && (
        <form
          noValidate
          className="border-border space-y-4 border-t pt-5"
          onSubmit={handleSubmit((v) =>
            link.mutate(v, {
              onSuccess: () => reset({ ...v, inventoryItemId: '', externalId: '' }),
            }),
          )}
        >
          {link.isError && <Alert tone="error">{integrationErrorMessage(link.error)}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Select label="Item de estoque" {...register('inventoryItemId')}>
                <option value="">Escolha…</option>
                {items.data?.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.product_name}
                    {i.attributes ? ` — ${describeAttributes(i.attributes)}` : ''} ({i.sku})
                  </option>
                ))}
              </Select>
              {errors.inventoryItemId && (
                <p className="text-danger text-xs">{errors.inventoryItemId.message}</p>
              )}
            </div>
            <TextField
              label="SKU no marketplace"
              className="font-mono"
              autoComplete="off"
              error={errors.externalId?.message}
              {...register('externalId')}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" {...register('syncStock')} />
            Enviar o estoque disponível ao marketplace
          </label>
          <Button type="submit" loading={link.isPending}>
            Vincular
          </Button>
        </form>
      )}
    </div>
  );
}

const eventTone: Record<IntegrationEvent['status'], string> = {
  ok: 'text-success',
  error: 'text-danger',
  skipped: 'text-muted',
};
const eventLabel: Record<IntegrationEvent['status'], string> = {
  ok: 'OK',
  error: 'Erro',
  skipped: 'Resolvido',
};

function Activity({ connection, canEdit }: { connection: Connection; canEdit: boolean }) {
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const events = useIntegrationEvents(orgId, connection.id);
  const retry = useRetryEvent(orgId);

  if (events.isPending) return <PageLoader />;
  if (events.isError) return <Alert tone="error">{integrationErrorMessage(events.error)}</Alert>;
  if (events.data.length === 0) {
    return <p className="text-muted text-sm">Nada por aqui ainda.</p>;
  }

  return (
    <div className="space-y-4">
      {retry.isError && <Alert tone="error">{integrationErrorMessage(retry.error)}</Alert>}
      {retry.isSuccess && (
        <Alert tone={retry.data === 'created' || retry.data === 'duplicate' ? 'success' : 'info'}>
          {retryMessages[retry.data]}
        </Alert>
      )}
      <ul className="divide-border -my-3 divide-y text-sm">
        {events.data.map((e) => (
          <li key={e.id} className="flex flex-wrap items-start gap-3 py-3">
            <span className={cn('w-20 shrink-0 text-xs font-medium', eventTone[e.status])}>
              {eventLabel[e.status]}
            </span>
            <div className="min-w-0 flex-1">
              <p>
                <span className="font-mono text-xs">{e.kind}</span>
                {e.external_id && <span className="text-muted"> · {e.external_id}</span>}
              </p>
              {e.message && <p className="text-muted text-xs">{e.message}</p>}
            </div>
            <span className="text-muted text-xs">{when(e.created_at)}</span>
            {canEdit && e.status === 'error' && e.retryable && (
              <Button
                variant="secondary"
                loading={retry.isPending && retry.variables === e.id}
                onClick={() => retry.mutate(e.id)}
              >
                Reprocessar
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function IntegrationPage() {
  const { connectionId = '' } = useParams();
  const [params] = useSearchParams();
  const mlParam = params.get('ml') ?? '';
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const canEdit = orgPermissions.manageIntegrations(active!.role);
  const connection = useConnection(orgId, connectionId);
  const c = connection.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        to="/integracoes"
        className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Integrações
      </Link>

      {!canEdit ? (
        <Alert tone="info">
          As integrações são gerenciadas por proprietários e administradores.
        </Alert>
      ) : connection.isPending ? (
        <PageLoader />
      ) : connection.isError ? (
        <Alert tone="error">{integrationErrorMessage(connection.error)}</Alert>
      ) : !c ? (
        <Alert tone="info">Conexão não encontrada nesta organização.</Alert>
      ) : (
        <div key={c.id} className="space-y-6">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">{c.name}</h1>
              <ConnectionStatusBadge status={c.status} />
            </div>
            <p className="text-muted text-sm">
              {providerLabels[c.provider]} · {c.external_account_id}
              {c.last_event_at && ` · último pedido recebido em ${when(c.last_event_at)}`}
            </p>
          </div>

          <Status connection={c} />

          {c.provider === 'mercadolivre' && mercadoLivreReturnMessages[mlParam] && (
            <Alert tone={mercadoLivreReturnMessages[mlParam].tone}>
              {mercadoLivreReturnMessages[mlParam].text}
            </Alert>
          )}

          {c.provider === 'mercadolivre' && (
            <Section
              title="Mercado Livre"
              description="Conectado por autorização (OAuth). Nada para configurar no painel do Mercado Livre."
            >
              <div className="space-y-4 text-sm">
                <ul className="text-muted list-disc space-y-1 pl-5">
                  <li>
                    Pedidos pagos entram pelas notificações do Mercado Livre
                    {c.auto_forward
                      ? ' e vão direto ao fornecedor (confirmados automaticamente).'
                      : ' como pendentes, para você confirmar.'}
                  </li>
                  <li>
                    Etiqueta e nota fiscal emitida pelo Faturador do Mercado Livre são anexadas ao
                    envio do fornecedor quando ficam prontas lá. Nota emitida em outro sistema:
                    anexe no pedido.
                  </li>
                  <li>
                    Envios Full ficam com o Mercado Livre e não entram; retirada/a combinar também
                    não.
                  </li>
                  <li>
                    Estoque: use o mesmo SKU no campo "SKU" (SELLER_SKU) do anúncio no Mercado Livre
                    e vincule abaixo.
                  </li>
                  <li>Publicar anúncio no Mercado Livre pela TheSigns ainda não é suportado.</li>
                </ul>
                {canEdit && c.status !== 'disconnected' && <AutoForwardToggle connection={c} />}
                {canEdit && c.status !== 'disconnected' && (
                  <MercadoLivreConnect
                    orgId={active!.organization.id}
                    defaultName={c.name}
                    label="Reconectar"
                  />
                )}
              </div>
            </Section>
          )}

          {c.status !== 'disconnected' && isConnectable(c.provider) && (
            <Section
              title="Webhook de pedidos"
              description="Configure no marketplace para que cada pedido chegue aqui."
            >
              <div className="space-y-5">
                <ol className="text-muted list-decimal space-y-1 pl-5 text-sm">
                  {webhookInstructions[c.provider].map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                <CopyField
                  value={webhookUrl(env.supabase?.url, c.provider, c.id)}
                  label="URL do webhook"
                />
                <RotateSecret connection={c} />
              </div>
            </Section>
          )}

          {c.status !== 'disconnected' && isConnectable(c.provider) && (
            <Section
              title="Credenciais de API"
              description="Necessárias para enviar o estoque ao marketplace. Ficam criptografadas e nunca são exibidas."
            >
              <CredentialsSection connection={c} />
            </Section>
          )}

          <Section
            title="Vínculos de SKU"
            description="Liga o SKU do marketplace ao seu estoque: identifica os itens dos pedidos e recebe o saldo."
          >
            <Links connection={c} canEdit={canEdit} />
          </Section>

          <Section
            title="Atividade"
            description="Pedidos recebidos e falhas. Pedidos com erro podem ser reprocessados depois de corrigir o vínculo."
          >
            <Activity connection={c} canEdit={canEdit} />
          </Section>
        </div>
      )}
    </div>
  );
}
