import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Section } from '@/components/ui/Section';
import { TextField } from '@/components/ui/TextField';
import { useOrganization } from '@/features/organizations/organization-context';
import { orgPermissions } from '@/features/organizations/roles';
import { cn } from '@/utils/cn';
import { centsToInput, parseBRL } from '@/utils/money';
import { usePricingSimulation, usePricingTarget, type SimulateArgs, type TargetArgs } from '../api';
import { AiGenerator } from '../components/AiGenerator';
import { PricingResult } from '../components/PricingResult';
import { ChannelFields, CostFields } from '../components/PricingInputs';
import {
  loadCostPrefs,
  parseCosts,
  parseMargin,
  saveCostPrefs,
  type Channel,
  type CostInputs,
} from '../tools';

const tabs = [
  { id: 'preco', label: 'Preço ideal' },
  { id: 'lucro', label: 'Simulador de lucro' },
  { id: 'ia', label: 'Textos com IA' },
] as const;
type Tab = (typeof tabs)[number]['id'];

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Mesmo conteúdo → mesma referência de argumentos (evita consultas repetidas). */
function useStableArgs<T>(args: T | null): T | null {
  const key = JSON.stringify(args);
  const debounced = useDebounced(key, 350);
  return debounced === 'null' ? null : (JSON.parse(debounced) as T);
}

export function ToolsPage() {
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('aba');
  const tab: Tab = tabs.some((t) => t.id === tabParam) ? (tabParam as Tab) : 'preco';

  const [channel, setChannel] = useState<Channel | null>(null);
  const [costs, setCosts] = useState<CostInputs>(() => ({
    cost: '',
    shipping: '',
    ...loadCostPrefs(),
  }));
  const [margin, setMargin] = useState('20');
  const [price, setPrice] = useState('');

  useEffect(() => {
    saveCostPrefs(costs);
  }, [costs]);

  const parsed = parseCosts(costs);
  const costErrors = parsed.ok ? {} : parsed.errors;
  const marginBps = parseMargin(margin);
  const priceCents = parseBRL(price);

  const targetArgs = useStableArgs<TargetArgs>(
    channel && parsed.ok && marginBps !== null ? { ...channel, ...parsed.value, marginBps } : null,
  );
  const simulateArgs = useStableArgs<SimulateArgs>(
    channel && parsed.ok && priceCents !== null && priceCents >= 1
      ? { ...channel, ...parsed.value, priceCents }
      : null,
  );
  const target = usePricingTarget(tab === 'preco' ? targetArgs : null);
  const simulation = usePricingSimulation(tab === 'lucro' ? simulateArgs : null);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Ferramentas</h1>
        <p className="text-muted mt-1 text-sm">
          Calcule o preço certo com as taxas reais de cada marketplace e gere textos de venda com
          IA.
        </p>
      </div>

      <div role="tablist" aria-label="Ferramentas" className="flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setParams(t.id === 'preco' ? {} : { aba: t.id }, { replace: true })}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
              tab === t.id ? 'bg-brand/10 text-brand' : 'text-muted hover:bg-surface-2',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'ia' ? (
        <Section
          title="Textos com IA"
          description="Títulos, legendas e roteiros a partir do cadastro do produto."
        >
          <AiGenerator orgId={orgId} canUse={orgPermissions.editCatalog(active!.role)} />
        </Section>
      ) : (
        <>
          <Section
            title="Onde e quanto custa"
            description="Taxas do marketplace cadastradas pela equipe; impostos e antecipação ficam salvos neste navegador."
          >
            <div className="space-y-6">
              <ChannelFields value={channel} onChange={setChannel} />
              <CostFields
                orgId={orgId}
                value={costs}
                errors={costErrors}
                onChange={setCosts}
                onProductPrice={(cents) => setPrice(centsToInput(cents))}
              />
            </div>
          </Section>

          {tab === 'preco' ? (
            <Section
              title="Preço ideal"
              description="O menor preço que deixa a margem desejada depois de taxas, impostos, antecipação, custo e frete."
            >
              <div className="space-y-6">
                <div className="max-w-xs">
                  <TextField
                    label="Margem desejada (%)"
                    inputMode="decimal"
                    hint="Lucro ÷ preço de venda."
                    error={
                      margin.trim() && marginBps === null ? 'De -100 a 99, ex.: 20' : undefined
                    }
                    value={margin}
                    onChange={(e) => setMargin(e.target.value)}
                  />
                </div>
                {targetArgs ? (
                  <PricingResult query={target} headline="price" />
                ) : (
                  <p className="text-muted text-sm">Informe a margem desejada para calcular.</p>
                )}
              </div>
            </Section>
          ) : (
            <Section
              title="Simulador de lucro"
              description="Quanto sobra por unidade vendida a um preço."
            >
              <div className="space-y-6">
                <div className="max-w-xs">
                  <TextField
                    label="Preço de venda (R$)"
                    inputMode="decimal"
                    placeholder="0,00"
                    error={price.trim() && !priceCents ? 'Valor inválido, ex.: 59,90' : undefined}
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                  />
                </div>
                {simulateArgs ? (
                  <PricingResult query={simulation} headline="profit" />
                ) : (
                  <p className="text-muted text-sm">Informe o preço de venda para simular.</p>
                )}
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
