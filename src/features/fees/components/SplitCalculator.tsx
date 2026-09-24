import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { providerLabels, type Provider } from '@/features/integrations/schemas';
import { cn } from '@/utils/cn';
import { centsToInput, formatBRL, parseBRL } from '@/utils/money';
import { useFeeRules, type SplitInput } from '../api';
import {
  commissionSourceLabels,
  feeOptions,
  feesErrorMessage,
  formatBps,
  type Split,
} from '../fees';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/**
 * Escolha de marketplace, tipo de anúncio, campanha, preço e quantidade.
 * Só oferece combinações que têm regra ativa cadastrada pela equipe.
 */
export function SplitInputs({
  defaultPriceCents,
  onChange,
  extra,
}: {
  defaultPriceCents: number | null;
  onChange: (input: SplitInput | null) => void;
  extra?: ReactNode;
}) {
  const rules = useFeeRules();
  const options = useMemo(() => feeOptions(rules.data ?? []), [rules.data]);
  const [provider, setProvider] = useState<Provider | ''>('');
  const [type, setType] = useState('');
  const [campaign, setCampaign] = useState('');
  const [price, setPrice] = useState(centsToInput(defaultPriceCents));
  const [qty, setQty] = useState('1');

  const current = options.find((o) => o.provider === provider) ?? options[0];
  const currentType = current?.types.find((t) => t.value === type) ?? current?.types[0];
  const currentCampaign = currentType?.campaigns.includes(campaign) ? campaign : '';

  const priceCents = parseBRL(price);
  const quantity = /^\d{1,4}$/.test(qty.trim()) ? Number(qty) : null;
  const priceError = price.trim() && (priceCents === null || priceCents < 1);
  const qtyError = quantity === null || quantity < 1;

  const input: SplitInput | null =
    current && currentType && priceCents && !qtyError
      ? {
          provider: current.provider,
          listingType: currentType.value,
          campaign: currentCampaign || null,
          unitPriceCents: priceCents,
          quantity: quantity!,
        }
      : null;
  const debounced = useDebounced(input, 350);
  const key = JSON.stringify(debounced);
  useEffect(() => {
    onChange(debounced);
    // `key` captura o conteúdo; `onChange` do pai pode mudar a cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (rules.isPending) return <PageLoader />;
  if (rules.isError) return <Alert tone="error">{feesErrorMessage(rules.error)}</Alert>;
  if (!current) {
    return (
      <Alert tone="info">
        Nenhuma taxa de marketplace configurada ainda. A equipe TheSigns cadastra as taxas em
        Administração → Taxas e comissões.
      </Alert>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Select
        label="Marketplace"
        value={current.provider}
        onChange={(e) => {
          setProvider(e.target.value as Provider);
          setType('');
          setCampaign('');
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
        value={currentType?.value ?? ''}
        onChange={(e) => {
          setType(e.target.value);
          setCampaign('');
        }}
      >
        {current.types.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </Select>
      {currentType && currentType.campaigns.length > 0 && (
        <Select
          label="Campanha do marketplace"
          value={currentCampaign}
          onChange={(e) => setCampaign(e.target.value)}
        >
          <option value="">Nenhuma</option>
          {currentType.campaigns.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      )}
      <TextField
        label="Preço de venda (unitário)"
        inputMode="decimal"
        placeholder="0,00"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        error={priceError ? 'Valor inválido, ex.: 89,90' : undefined}
      />
      <TextField
        label="Quantidade"
        inputMode="numeric"
        value={qty}
        onChange={(e) => setQty(e.target.value)}
        error={qtyError ? 'Informe de 1 a 9999.' : undefined}
      />
      {extra}
    </div>
  );
}

function Line({
  label,
  hint,
  cents,
  sign,
  strong,
}: {
  label: string;
  hint?: string;
  cents: number;
  sign?: '−' | '=';
  strong?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-3 py-2',
        strong && 'border-border border-t pt-3 text-base font-semibold',
      )}
    >
      <dt className="min-w-0">
        {sign && <span className="text-muted mr-1.5 inline-block w-3">{sign}</span>}
        {label}
        {hint && <span className="text-muted block text-xs font-normal">{hint}</span>}
      </dt>
      <dd className={cn('tabular-nums', cents < 0 && 'text-danger')}>{formatBRL(cents)}</dd>
    </div>
  );
}

/** Demonstrativo: venda − marketplace − fornecedor − vendedor = TheSigns. */
export function SplitBreakdown({ split }: { split: Split }) {
  const fee = split.fee_rule;
  const extra = split.campaign_rule;
  const feeHint = [
    `${fee.label}: ${formatBps(fee.percent_bps)}${fee.fixed_cents_per_item ? ` + ${formatBRL(fee.fixed_cents_per_item)}/item` : ''}`,
    extra &&
      `campanha ${extra.campaign}: ${formatBps(extra.percent_bps)}${extra.fixed_cents_per_item ? ` + ${formatBRL(extra.fixed_cents_per_item)}/item` : ''}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const sellerShare = split.sale_cents
    ? (split.seller_commission_cents * 10000) / split.sale_cents
    : 0;

  return (
    <div className="space-y-4">
      <dl className="text-sm">
        <Line
          label="Preço de venda"
          hint={
            split.quantity > 1
              ? `${split.quantity} × ${formatBRL(split.unit_price_cents)}`
              : undefined
          }
          cents={split.sale_cents}
        />
        <Line
          sign="−"
          label="Taxas do marketplace"
          hint={feeHint}
          cents={split.marketplace_fee_cents}
        />
        <Line sign="−" label="Custo do fornecedor" cents={split.supplier_cents} />
        <Line
          sign="−"
          label="Comissão do vendedor"
          hint={`${formatBps(split.seller_commission_bps)} · ${commissionSourceLabels[split.seller_commission_source]}`}
          cents={split.seller_commission_cents}
        />
        <Line sign="=" label="Receita estimada da TheSigns" cents={split.platform_cents} strong />
      </dl>

      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        {[
          {
            label: 'Lucro do vendedor',
            value: formatBRL(split.seller_commission_cents),
            sub: `${formatBps(Math.round(sellerShare))} da venda`,
          },
          { label: 'Valor do fornecedor', value: formatBRL(split.supplier_cents) },
          { label: 'Taxas', value: formatBRL(split.marketplace_fee_cents) },
          {
            label: 'Margem TheSigns',
            value: formatBps(split.platform_margin_bps),
            danger: split.platform_cents < 0,
          },
        ].map((c) => (
          <div key={c.label} className="border-border bg-surface-2/50 rounded-lg border px-3 py-2">
            <dt className="text-muted text-xs">{c.label}</dt>
            <dd className={cn('font-semibold tabular-nums', c.danger && 'text-danger')}>
              {c.value}
            </dd>
            {c.sub && <dd className="text-muted text-xs">{c.sub}</dd>}
          </div>
        ))}
      </dl>

      {split.platform_cents < 0 && (
        <Alert tone="error">
          Com este preço a venda dá prejuízo para a plataforma. Aumente o preço de venda.
        </Alert>
      )}
      <p className="text-muted text-xs">
        Estimativa com as taxas e comissões cadastradas hoje. Frete, impostos e taxas do meio de
        pagamento não estão incluídos.
      </p>
    </div>
  );
}

/** Resultado de uma consulta de divisão (estados de carregando/erro/vazio). */
export function SplitResult({
  query,
}: {
  query: { data?: Split | undefined; isFetching: boolean; isError: boolean; error: unknown };
}) {
  if (query.isError) return <Alert tone="error">{feesErrorMessage(query.error)}</Alert>;
  if (!query.data) {
    return query.isFetching ? (
      <PageLoader />
    ) : (
      <p className="text-muted text-sm">Informe o preço de venda para ver a divisão.</p>
    );
  }
  return (
    <div
      className={cn('transition-opacity', query.isFetching && 'opacity-60')}
      aria-busy={query.isFetching}
    >
      <SplitBreakdown split={query.data} />
    </div>
  );
}
