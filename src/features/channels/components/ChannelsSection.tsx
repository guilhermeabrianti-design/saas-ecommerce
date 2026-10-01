import { useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { useCategories, useFeeRules } from '@/features/fees/api';
import { categoryPath, feeOptions, sortCategories, type FeeOptions } from '@/features/fees/fees';
import { providerLabels, providers, type Provider } from '@/features/integrations/schemas';
import type { Product } from '@/features/products/api';
import { usePricingSimulation } from '@/features/tools/api';
import { ProductToolsPanel } from '@/features/tools/components/ProductToolsPanel';
import { cn } from '@/utils/cn';
import { formatBRL, parseBRL } from '@/utils/money';
import { useChannelConfigs, useSaveChannelConfig } from '../api';
import {
  TITLE_LIMITS,
  channelErrorMessage,
  channelForm,
  freeShippingWarning,
  validateChannel,
  type ChannelConfig,
  type ChannelForm,
} from '../channels';

/** Taxa do marketplace e lucro com o preço do canal (custo do produto; sem impostos e frete). */
function ProfitEstimate({
  provider,
  form,
  costCents,
}: {
  provider: Provider;
  form: ChannelForm;
  costCents: number;
}) {
  const price = parseBRL(form.price);
  const sim = usePricingSimulation(
    price && price > 0 && form.listingType
      ? {
          provider,
          listingType: form.listingType,
          categoryId: form.categoryId || null,
          priceCents: price,
          costCents,
          shippingCents: 0,
          taxBps: 0,
          anticipationBps: 0,
        }
      : null,
  );
  if (!sim.data) return null;
  const d = sim.data;
  return (
    <p className="text-muted text-sm">
      Taxa {d.fee_rule.label}: {formatBRL(d.marketplace_fee_cents)} · Custo{' '}
      {formatBRL(d.cost_cents)} ·{' '}
      <span className={cn('font-medium', d.profit_cents < 0 ? 'text-danger' : 'text-fg')}>
        Lucro estimado {formatBRL(d.profit_cents)} ({(d.margin_bps / 100).toFixed(1)}%)
      </span>
      <span className="block text-xs">Antes de impostos e do frete pago por você.</span>
    </p>
  );
}

function ChannelTab({
  product,
  provider,
  saved,
  options,
  canEdit,
}: {
  product: Product;
  provider: Provider;
  saved: ChannelConfig | undefined;
  options: FeeOptions[];
  canEdit: boolean;
}) {
  const save = useSaveChannelConfig(product.id);
  const categories = useCategories();
  const sorted = useMemo(
    () => sortCategories((categories.data ?? []).filter((c) => c.is_active)),
    [categories.data],
  );
  const [form, setForm] = useState<ChannelForm>(() =>
    channelForm(provider, saved, product, options),
  );
  const [touched, setTouched] = useState(false);
  const errors = validateChannel(provider, form);
  const valid = Object.keys(errors).length === 0;
  const types = options.find((o) => o.provider === provider)?.types ?? [];
  const set = (patch: Partial<ChannelForm>) => setForm((f) => ({ ...f, ...patch }));
  const warning = freeShippingWarning(provider, form);
  const limit = TITLE_LIMITS[provider];

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (valid) save.mutate({ provider, form });
      }}
    >
      {!saved && (
        <Alert tone="info">
          Sugestão a partir do produto. Revise e salve para deixar o anúncio pronto.
        </Alert>
      )}
      {save.isError && <Alert tone="error">{channelErrorMessage(save.error)}</Alert>}
      {types.length === 0 && (
        <Alert tone="info">
          Nenhuma taxa de {providerLabels[provider]} cadastrada ainda. A equipe TheSigns cadastra em
          Taxas e comissões; até lá não dá para salvar este canal.
        </Alert>
      )}

      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          className="size-4"
          checked={form.enabled}
          disabled={!canEdit}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        <span className="font-medium">Vender neste canal</span>
      </label>

      <TextField
        label={`Título (${form.title.trim().length}/${limit})`}
        value={form.title}
        disabled={!canEdit}
        maxLength={limit}
        error={touched ? errors.title : undefined}
        onChange={(e) => set({ title: e.target.value })}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Preço neste canal (R$)"
          inputMode="decimal"
          value={form.price}
          disabled={!canEdit}
          error={touched ? errors.price : undefined}
          onChange={(e) => set({ price: e.target.value })}
        />
        <Select
          label="Tipo de anúncio"
          value={form.listingType}
          disabled={!canEdit || types.length === 0}
          onChange={(e) => set({ listingType: e.target.value })}
        >
          {types.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </Select>
        <Select
          label="Categoria (para a taxa)"
          value={form.categoryId}
          disabled={!canEdit}
          onChange={(e) => set({ categoryId: e.target.value })}
        >
          <option value="">Sem categoria (taxa geral)</option>
          {sorted.map((c) => (
            <option key={c.id} value={c.id}>
              {categoryPath(c, sorted)}
            </option>
          ))}
        </Select>
        <TextField
          label={`Código da categoria no ${providerLabels[provider]} (opcional)`}
          placeholder={provider === 'mercadolivre' ? 'Ex.: MLB1234' : 'Código do canal'}
          className="font-mono"
          value={form.marketplaceCategory}
          disabled={!canEdit}
          error={touched ? errors.marketplaceCategory : undefined}
          onChange={(e) => set({ marketplaceCategory: e.target.value })}
        />
      </div>
      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          className="size-4"
          checked={form.freeShipping}
          disabled={!canEdit}
          onChange={(e) => set({ freeShipping: e.target.checked })}
        />
        <span>Frete grátis para o comprador</span>
      </label>
      {warning && <Alert tone="info">{warning}</Alert>}

      <ProfitEstimate provider={provider} form={form} costCents={product.cost_cents ?? 0} />

      {canEdit && (
        <Button type="submit" loading={save.isPending} disabled={types.length === 0}>
          Salvar {providerLabels[provider]}
        </Button>
      )}
    </form>
  );
}

/**
 * Exportar o produto para um marketplace (só vendedor). Fica fechado até o
 * vendedor escolher o canal; aí aparecem a configuração do anúncio e as
 * ferramentas (preço ideal, lucro e textos com IA) já com este produto.
 */
export function ChannelsSection({ product, canEdit }: { product: Product; canEdit: boolean }) {
  const configs = useChannelConfigs(product.id);
  const rules = useFeeRules();
  const options = useMemo(() => feeOptions(rules.data ?? []), [rules.data]);
  const [open, setOpen] = useState<Provider | null>(null);
  const current = open ? configs.data?.find((c) => c.provider === open) : undefined;

  return (
    <Section
      title="Exportar para marketplaces"
      description="Escolha onde vender este produto. O anúncio e as ferramentas aparecem ao escolher."
    >
      {configs.isPending || rules.isPending ? (
        <PageLoader />
      ) : configs.isError ? (
        <Alert tone="error">{channelErrorMessage(configs.error)}</Alert>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap gap-2">
            {providers.map((p) => {
              const saved = configs.data.find((c) => c.provider === p);
              return (
                <Button
                  key={p}
                  variant={open === p ? 'primary' : 'secondary'}
                  aria-pressed={open === p}
                  onClick={() => setOpen(open === p ? null : p)}
                >
                  Exportar para {providerLabels[p]}
                  {saved && (
                    <span className="text-xs font-normal opacity-80">
                      {saved.enabled ? '· pronto' : '· desligado'}
                    </span>
                  )}
                </Button>
              );
            })}
          </div>

          {open && (
            <>
              <ChannelTab
                key={`${open}:${current?.updated_at ?? 'novo'}:${options.length}`}
                product={product}
                provider={open}
                saved={current}
                options={options}
                canEdit={canEdit}
              />
              <div className="border-border border-t pt-6">
                <ProductToolsPanel key={open} product={product} provider={open} />
              </div>
              <p className="text-muted text-xs">
                Publicar direto no marketplace a partir daqui chega nas próximas fases. Pedidos do
                Mercado Livre já entram e vão sozinhos ao fornecedor.
              </p>
            </>
          )}
        </div>
      )}
    </Section>
  );
}
