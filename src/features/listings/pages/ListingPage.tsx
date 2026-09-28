import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, CircleCheck, CircleX, ExternalLink, Loader2 } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { useOrganization } from '@/features/organizations/organization-context';
import { cn } from '@/utils/cn';
import { centsToInput, parseBRL } from '@/utils/money';
import {
  useChannelListing,
  useDeleteListing,
  useDuplicateListing,
  useListingAction,
  useListingSteps,
  usePublishableConnections,
  useSaveListing,
} from '../api';
import {
  actionLabels,
  groupRuns,
  listingErrorMessage,
  listingFormSchema,
  listingStatusLabels,
  listingStatusTone,
  providerLabels,
  stepLabels,
  type ChannelListing,
  type ListingFormValues,
} from '../listings';

const when = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });

function EditForm({ orgId, listing }: { orgId: string; listing: ChannelListing }) {
  const save = useSaveListing(orgId);
  const busy = listing.status === 'publishing';
  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
    reset,
  } = useForm<ListingFormValues>({
    resolver: zodResolver(listingFormSchema),
    defaultValues: {
      title: listing.title,
      description: listing.description ?? '',
      price: centsToInput(listing.price_cents),
    },
  });
  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={handleSubmit((v) =>
        save.mutate(
          {
            id: listing.id,
            connectionId: null,
            productId: null,
            title: v.title,
            description: v.description,
            priceCents: v.price.trim() ? parseBRL(v.price) : null,
          },
          { onSuccess: () => reset(v) },
        ),
      )}
    >
      {save.isError && <Alert tone="error">{listingErrorMessage(save.error)}</Alert>}
      {save.isSuccess && !isDirty && (
        <Alert tone="success">
          Salvo. {listing.external_id ? 'Publique de novo para enviar as mudanças à loja.' : ''}
        </Alert>
      )}
      <TextField label="Título" error={errors.title?.message} {...register('title')} />
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">Descrição</span>
        <textarea
          rows={6}
          className="border-border bg-surface w-full rounded-lg border px-3 py-2 text-sm"
          {...register('description')}
        />
        {errors.description && (
          <span className="text-danger text-xs">{errors.description.message}</span>
        )}
      </label>
      <div className="max-w-56">
        <TextField
          label="Preço (R$)"
          inputMode="decimal"
          hint="Vazio = preço do produto. Variação com preço próprio mantém o dela."
          error={errors.price?.message}
          {...register('price')}
        />
      </div>
      <Button
        type="submit"
        variant="secondary"
        disabled={busy || !isDirty}
        loading={save.isPending}
      >
        Salvar
      </Button>
    </form>
  );
}

function Actions({ orgId, listing }: { orgId: string; listing: ChannelListing }) {
  const action = useListingAction(orgId, listing.id);
  const busy = listing.status === 'publishing' || action.isPending;
  const published = listing.external_id != null;
  return (
    <div className="space-y-3">
      {action.isError && <Alert tone="error">{listingErrorMessage(action.error)}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          loading={busy && action.variables === 'publish'}
          disabled={busy}
          onClick={() => action.mutate('publish')}
        >
          {published ? 'Enviar alterações' : 'Publicar'}
        </Button>
        {published && listing.status !== 'paused' && (
          <Button
            variant="secondary"
            loading={busy && action.variables === 'pause'}
            disabled={busy}
            onClick={() => action.mutate('pause')}
          >
            Pausar
          </Button>
        )}
        {published && listing.status === 'paused' && (
          <Button
            variant="secondary"
            loading={busy && action.variables === 'activate'}
            disabled={busy}
            onClick={() => action.mutate('activate')}
          >
            Reativar
          </Button>
        )}
      </div>
    </div>
  );
}

function Progress({ listingId, running }: { listingId: string; running: boolean }) {
  const steps = useListingSteps(listingId, running);
  if (steps.isPending) return <PageLoader />;
  if (steps.isError) return <Alert tone="error">{listingErrorMessage(steps.error)}</Alert>;
  const runs = groupRuns(steps.data);
  if (!runs.length) return <p className="text-muted text-sm">Nada enviado ainda.</p>;
  return (
    <ol className="space-y-5">
      {runs.map((run, i) => (
        <li key={run.runId}>
          <p className="text-sm font-medium">
            {actionLabels[run.action]} · {when(run.startedAt)}
            {!run.finished && i === 0 && running && (
              <span className="text-brand"> · em andamento</span>
            )}
          </p>
          <ul className="mt-2 space-y-1.5">
            {run.steps.map((s) => (
              <li key={s.id} className="flex items-start gap-2 text-sm">
                {s.status === 'ok' ? (
                  <CircleCheck className="text-success mt-0.5 size-4 shrink-0" aria-label="ok" />
                ) : (
                  <CircleX className="text-danger mt-0.5 size-4 shrink-0" aria-label="erro" />
                )}
                <span>
                  <span className="font-medium">{stepLabels[s.step]}</span>
                  {s.message && <span className="text-muted"> — {s.message}</span>}
                </span>
              </li>
            ))}
            {!run.finished && i === 0 && running && (
              <li className="text-muted flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Aguardando o marketplace…
              </li>
            )}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function MoreActions({ orgId, listing }: { orgId: string; listing: ChannelListing }) {
  const connections = usePublishableConnections(orgId);
  const duplicate = useDuplicateListing(orgId);
  const remove = useDeleteListing(orgId);
  const navigate = useNavigate();
  const [target, setTarget] = useState('');
  const others = (connections.data ?? []).filter(
    (c) => c.id !== listing.connection_id && c.status === 'active',
  );
  return (
    <div className="space-y-4">
      {(duplicate.isError || remove.isError) && (
        <Alert tone="error">{listingErrorMessage(duplicate.error ?? remove.error)}</Alert>
      )}
      {others.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-64">
            <Select
              label="Duplicar para outra loja"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">Escolha…</option>
              {others.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({providerLabels[c.provider] ?? c.provider})
                </option>
              ))}
            </Select>
          </div>
          <Button
            variant="secondary"
            disabled={!target}
            loading={duplicate.isPending}
            onClick={() =>
              duplicate.mutate(
                { id: listing.id, connectionId: target },
                { onSuccess: (id) => void navigate(`/anuncios/${id}`) },
              )
            }
          >
            Duplicar
          </Button>
        </div>
      )}
      {!listing.external_id && listing.status !== 'publishing' && (
        <ConfirmButton
          confirmLabel="Apagar rascunho"
          loading={remove.isPending}
          onConfirm={() =>
            remove.mutate(listing.id, { onSuccess: () => void navigate('/anuncios') })
          }
        >
          Apagar rascunho
        </ConfirmButton>
      )}
    </div>
  );
}

export function ListingPage() {
  const { listingId = '' } = useParams();
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const query = useChannelListing(listingId);
  const l = query.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        to="/anuncios"
        className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Anúncios
      </Link>
      {query.isPending ? (
        <PageLoader />
      ) : query.isError ? (
        <Alert tone="error">{listingErrorMessage(query.error)}</Alert>
      ) : !l ? (
        <Alert tone="info">Anúncio não encontrado.</Alert>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-muted text-sm">
                {l.integration_connections?.name} ·{' '}
                {providerLabels[l.integration_connections?.provider ?? '']} · {l.products?.name} (
                {l.products?.sku})
              </p>
              <h1 className="text-2xl font-semibold tracking-tight">{l.title}</h1>
            </div>
            <span
              className={cn('rounded px-2 py-1 text-xs font-medium', listingStatusTone[l.status])}
            >
              {listingStatusLabels[l.status]}
            </span>
          </div>
          {l.external_url && (
            <a
              href={l.external_url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-brand inline-flex items-center gap-1 text-sm hover:underline"
            >
              Ver no marketplace <ExternalLink className="size-4" aria-hidden />
            </a>
          )}
          {l.last_error && (
            <Alert tone="error">{listingErrorMessage({ message: l.last_error })}</Alert>
          )}

          <Section
            title="Publicação"
            description="Cada etapa abaixo é registrada no momento em que acontece."
          >
            <div className="space-y-6">
              <Actions orgId={orgId} listing={l} />
              <Progress listingId={l.id} running={l.status === 'publishing'} />
            </div>
          </Section>

          <Section
            title="Conteúdo do anúncio"
            description="Fotos, variações e SKUs vêm do produto."
          >
            <EditForm key={l.updated_at} orgId={orgId} listing={l} />
          </Section>

          <Section title="Mais ações" description="Duplicar para outra loja ou apagar rascunho.">
            <MoreActions orgId={orgId} listing={l} />
          </Section>
        </>
      )}
    </div>
  );
}
