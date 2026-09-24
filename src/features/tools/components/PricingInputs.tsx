import { useEffect, useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { useCategories, useFeeRules } from '@/features/fees/api';
import { categoryPath, feeOptions, feesErrorMessage, sortCategories } from '@/features/fees/fees';
import { providerLabels, type Provider } from '@/features/integrations/schemas';
import { centsToInput, formatBRL } from '@/utils/money';
import { useProductOptions } from '../api';
import type { Channel, CostInputs } from '../tools';

/** Marketplace, tipo de anúncio e categoria — só combinações com taxa ativa cadastrada. */
export function ChannelFields({
  value,
  onChange,
}: {
  value: Channel | null;
  onChange: (c: Channel) => void;
}) {
  const rules = useFeeRules();
  const categories = useCategories();
  const options = useMemo(() => feeOptions(rules.data ?? []), [rules.data]);
  const sorted = useMemo(
    () => sortCategories((categories.data ?? []).filter((c) => c.is_active)),
    [categories.data],
  );

  const current = options.find((o) => o.provider === value?.provider) ?? options[0];
  const type = current?.types.find((t) => t.value === value?.listingType) ?? current?.types[0];
  const categoryId = value?.categoryId ?? null;

  // Mantém o pai informado da escolha efetiva (a primeira opção quando nada foi escolhido
  // ou quando a regra escolhida deixou de existir).
  const stale =
    current && type && (value?.provider !== current.provider || value.listingType !== type.value);
  useEffect(() => {
    if (stale) onChange({ provider: current.provider, listingType: type.value, categoryId });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `onChange` do pai muda a cada render
  }, [stale, current?.provider, type?.value, categoryId]);

  if (rules.isPending) return <PageLoader />;
  if (rules.isError) return <Alert tone="error">{feesErrorMessage(rules.error)}</Alert>;
  if (!current || !type) {
    return (
      <Alert tone="info">
        Nenhuma taxa de marketplace configurada ainda. A equipe TheSigns cadastra as taxas em
        Administração › Taxas e comissões.
      </Alert>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Select
        label="Marketplace"
        value={current.provider}
        onChange={(e) => {
          const next = options.find((o) => o.provider === e.target.value)!;
          onChange({
            provider: next.provider as Provider,
            listingType: next.types[0]!.value,
            categoryId,
          });
        }}
      >
        {options.map((o) => (
          <option key={o.provider} value={o.provider}>
            {providerLabels[o.provider]}
          </option>
        ))}
      </Select>
      <Select
        label="Tipo de anúncio"
        value={type.value}
        onChange={(e) =>
          onChange({ provider: current.provider, listingType: e.target.value, categoryId })
        }
      >
        {current.types.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </Select>
      <Select
        label="Categoria"
        value={categoryId ?? ''}
        onChange={(e) =>
          onChange({
            provider: current.provider,
            listingType: type.value,
            categoryId: e.target.value || null,
          })
        }
      >
        <option value="">Sem categoria (taxa geral)</option>
        {sorted.map((c) => (
          <option key={c.id} value={c.id}>
            {categoryPath(c, sorted)}
          </option>
        ))}
      </Select>
    </div>
  );
}

/** Custo (com atalho a partir de um produto), frete, impostos e antecipação. */
export function CostFields({
  orgId,
  value,
  errors,
  onChange,
  onProductPrice,
}: {
  orgId: string;
  value: CostInputs;
  errors: Partial<Record<string, string>>;
  onChange: (v: CostInputs) => void;
  /** Recebe o preço de venda cadastrado quando um produto é escolhido. */
  onProductPrice?: (cents: number) => void;
}) {
  const [search, setSearch] = useState('');
  const products = useProductOptions(orgId, search);
  const set = (patch: Partial<CostInputs>) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Buscar produto (opcional)"
          placeholder="Preenche o custo com o do cadastro"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          label="Produto"
          value=""
          onChange={(e) => {
            const p = products.data?.find((x) => x.id === e.target.value);
            if (!p) return;
            set({ cost: centsToInput(p.cost_cents) });
            onProductPrice?.(p.price_cents);
          }}
        >
          <option value="">
            {products.isPending ? 'Carregando…' : 'Escolha para preencher o custo'}
          </option>
          {products.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · custo {p.cost_cents === null ? 'não cadastrado' : formatBRL(p.cost_cents)}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <TextField
          label="Custo do produto (R$)"
          inputMode="decimal"
          placeholder="0,00"
          hint="Atacado do fornecedor ou seu custo."
          error={errors.cost}
          value={value.cost}
          onChange={(e) => set({ cost: e.target.value })}
        />
        <TextField
          label="Frete pago por você (R$)"
          inputMode="decimal"
          placeholder="0,00"
          error={errors.shipping}
          value={value.shipping}
          onChange={(e) => set({ shipping: e.target.value })}
        />
        <TextField
          label="Impostos (%)"
          inputMode="decimal"
          placeholder="Ex.: 6"
          hint="Sobre o preço de venda."
          error={errors.tax}
          value={value.tax}
          onChange={(e) => set({ tax: e.target.value })}
        />
        <TextField
          label="Antecipação (%)"
          inputMode="decimal"
          placeholder="Ex.: 2,99"
          hint="Para receber antes do prazo."
          error={errors.anticipation}
          value={value.anticipation}
          onChange={(e) => set({ anticipation: e.target.value })}
        />
      </div>
    </div>
  );
}
