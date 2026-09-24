import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, X } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { useAdminListingSearch } from '@/features/fees/api';
import { providerLabels, providers } from '@/features/integrations/schemas';
import { useAdminCampaign, useSaveCampaign, type AdminCampaign } from '../api';
import {
  campaignFormSchema,
  campaignStatusLabels,
  campaignStatuses,
  salesErrorMessage,
  toLocalInput,
  type CampaignFormValues,
} from '../sales';

interface PickedListing {
  listing_id: string;
  product_name: string;
  supplier_name: string;
}

function ListingPicker({
  value,
  onChange,
  known,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  known: Map<string, PickedListing>;
}) {
  const [search, setSearch] = useState('');
  const results = useAdminListingSearch(search);
  const selected = value.map(
    (id) => known.get(id) ?? { listing_id: id, product_name: id, supplier_name: '' },
  );

  return (
    <div className="space-y-3">
      <TextField
        label="Adicionar produto"
        placeholder="Buscar por produto ou fornecedor (2+ letras)"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {search.trim().length >= 2 && results.data && (
        <ul className="border-border max-h-56 divide-y overflow-auto rounded-lg border text-sm">
          {results.data.length === 0 && <li className="text-muted px-3 py-2">Nada encontrado.</li>}
          {results.data.map((r) => {
            const added = value.includes(r.listing_id);
            return (
              <li key={r.listing_id}>
                <button
                  type="button"
                  disabled={added}
                  onClick={() => {
                    known.set(r.listing_id, r);
                    onChange([...value, r.listing_id]);
                  }}
                  className="hover:bg-surface-2 flex w-full items-center justify-between gap-3 px-3 py-2 text-left disabled:opacity-50"
                >
                  <span>
                    {r.product_name}
                    <span className="text-muted"> · {r.supplier_name}</span>
                    {!r.is_published && <span className="text-muted"> · não publicado</span>}
                  </span>
                  <span className="text-brand text-xs">{added ? 'Incluído' : 'Incluir'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {selected.length === 0 ? (
        <p className="text-muted text-sm">Nenhum produto incluído.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {selected.map((l) => (
            <li
              key={l.listing_id}
              className="bg-surface-2 inline-flex items-center gap-1 rounded-full py-1 pr-1 pl-3 text-sm"
            >
              {l.product_name}
              {l.supplier_name && <span className="text-muted">· {l.supplier_name}</span>}
              <button
                type="button"
                onClick={() => onChange(value.filter((id) => id !== l.listing_id))}
                className="text-muted hover:text-danger rounded-full p-1"
                aria-label={`Remover ${l.product_name}`}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function defaults(c: AdminCampaign | undefined): CampaignFormValues {
  const start = new Date(Date.now() + 86_400_000);
  start.setMinutes(0, 0, 0);
  return {
    name: c?.name ?? '',
    description: c?.description ?? '',
    provider: c?.provider ?? '',
    startsAt: toLocalInput(c?.starts_at ?? start.toISOString()),
    endsAt: toLocalInput(c?.ends_at ?? new Date(start.getTime() + 3 * 3600_000).toISOString()),
    commission: c?.commission_bps == null ? '' : String(c.commission_bps / 100).replace('.', ','),
    status: c?.status ?? 'draft',
    listingIds: c?.listings.map((l) => l.listing_id) ?? [],
  };
}

function CampaignForm({ campaign }: { campaign: AdminCampaign | undefined }) {
  const navigate = useNavigate();
  const save = useSaveCampaign();
  const [known] = useState(
    () => new Map<string, PickedListing>(campaign?.listings.map((l) => [l.listing_id, l]) ?? []),
  );
  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isDirty },
    reset,
  } = useForm<CampaignFormValues>({
    resolver: zodResolver(campaignFormSchema),
    defaultValues: defaults(campaign),
  });

  const onSubmit = handleSubmit((values) =>
    save.mutate(
      { id: campaign?.id ?? null, values },
      {
        onSuccess: (id) => {
          reset(values);
          if (!campaign) navigate(`/admin/lives/${id}`, { replace: true });
        },
      },
    ),
  );

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      {save.isError && <Alert tone="error">{salesErrorMessage(save.error)}</Alert>}
      {save.isSuccess && !isDirty && <Alert tone="success">Campanha salva.</Alert>}

      <Section title="Campanha" description="O que o vendedor vê na Central de Vendas.">
        <div className="space-y-4">
          <TextField label="Nome" error={errors.name?.message} {...register('name')} />
          <div className="space-y-1.5">
            <label htmlFor="campaign-description" className="block text-sm font-medium">
              Descrição
            </label>
            <textarea
              id="campaign-description"
              rows={4}
              className="border-border bg-surface focus:border-brand focus:ring-brand/30 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2"
              placeholder="Horário da live, tema, regras…"
              {...register('description')}
            />
            {errors.description && (
              <p className="text-danger text-xs">{errors.description.message}</p>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Início"
              type="datetime-local"
              error={errors.startsAt?.message}
              {...register('startsAt')}
            />
            <TextField
              label="Fim"
              type="datetime-local"
              error={errors.endsAt?.message}
              {...register('endsAt')}
            />
            <Select label="Marketplace" {...register('provider')}>
              <option value="">Qualquer canal</option>
              {providers.map((p) => (
                <option key={p} value={p}>
                  {providerLabels[p]}
                </option>
              ))}
            </Select>
            <TextField
              label="Comissão do vendedor (%)"
              inputMode="decimal"
              placeholder="Vazio = regras normais"
              hint="Vale para quem participa, nos produtos incluídos, enquanto a campanha estiver no ar."
              error={errors.commission?.message}
              {...register('commission')}
            />
            <Select label="Situação" {...register('status')}>
              {campaignStatuses.map((s) => (
                <option key={s} value={s}>
                  {campaignStatusLabels[s]}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Section>

      <Section
        title="Produtos"
        description="Anúncios do catálogo incluídos na campanha (até 200). Só aparecem ao vendedor os que estiverem visíveis no catálogo."
      >
        <Controller
          control={control}
          name="listingIds"
          render={({ field }) => (
            <ListingPicker value={field.value} onChange={field.onChange} known={known} />
          )}
        />
        {errors.listingIds && (
          <p className="text-danger mt-2 text-xs">{errors.listingIds.message}</p>
        )}
      </Section>

      <Button type="submit" loading={save.isPending} disabled={!!campaign && !isDirty}>
        {campaign ? 'Salvar alterações' : 'Criar campanha'}
      </Button>
    </form>
  );
}

export function LiveCampaignEditorPage() {
  const { campaignId = 'nova' } = useParams();
  const id = campaignId === 'nova' ? null : campaignId;
  const campaign = useAdminCampaign(id);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        to="/admin/lives"
        className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Campanhas para lives
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">
        {id ? (campaign.data?.name ?? 'Campanha') : 'Nova campanha'}
      </h1>

      {id && campaign.isPending ? (
        <PageLoader />
      ) : id && campaign.isError ? (
        <Alert tone="error">{salesErrorMessage(campaign.error)}</Alert>
      ) : (
        <>
          {/* Chave: trocar de campanha recria o formulário. */}
          <CampaignForm key={id ?? 'nova'} campaign={campaign.data} />
          {campaign.data && (
            <Section
              title="Lojas participantes"
              description="Vendedores que se inscreveram na campanha."
            >
              {campaign.data.participants.length === 0 ? (
                <p className="text-muted text-sm">Nenhuma loja inscrita ainda.</p>
              ) : (
                <ul className="divide-border -my-2 divide-y text-sm">
                  {campaign.data.participants.map((p) => (
                    <li key={p.organization_id} className="flex justify-between gap-3 py-2">
                      <span className="font-medium">{p.organization_name}</span>
                      <span className="text-muted">
                        {new Date(p.joined_at).toLocaleString('pt-BR')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}
        </>
      )}
    </div>
  );
}
