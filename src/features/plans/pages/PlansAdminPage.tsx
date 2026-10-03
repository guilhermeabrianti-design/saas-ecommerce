import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { orgKindLabels, orgKinds, type OrgKind } from '@/features/organizations/roles';
import { formatBRL } from '@/utils/money';
import { useAdminBilling, useSavePlan } from '../api';
import {
  formatPlanPrice,
  plansErrorMessage,
  subscriptionStatusLabels,
  planDraftToInput,
  toPlanDraft,
  type AdminPlan,
  type PlanDraft,
} from '../plans';

const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

function PlanForm({ plan, onDone }: { plan: AdminPlan | null; onDone?: () => void }) {
  const save = useSavePlan();
  const [d, setD] = useState<PlanDraft>(toPlanDraft(plan));
  const isDefault = plan?.is_default ?? false;
  const input = planDraftToInput(d, plan?.id ?? null, isDefault);
  const set = (patch: Partial<PlanDraft>) => setD((prev) => ({ ...prev, ...patch }));

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (input) save.mutate(input, { onSuccess: () => onDone?.() });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {!plan && (
          <Select
            label="Tipo de conta"
            value={d.org_kind}
            onChange={(e) => set({ org_kind: e.target.value as OrgKind })}
          >
            {orgKinds.map((k) => (
              <option key={k} value={k}>
                {orgKindLabels[k]}
              </option>
            ))}
          </Select>
        )}
        <TextField label="Nome" value={d.name} onChange={(e) => set({ name: e.target.value })} />
        {!isDefault && (
          <TextField
            label="Preço mensal"
            inputMode="decimal"
            placeholder="49,90"
            value={d.price}
            onChange={(e) => set({ price: e.target.value })}
          />
        )}
        <TextField
          label="Gerações de IA por dia"
          inputMode="numeric"
          placeholder="Padrão da plataforma"
          value={d.ai}
          onChange={(e) => set({ ai: e.target.value })}
        />
        <TextField
          label="Máximo de produtos"
          inputMode="numeric"
          placeholder="Sem limite"
          value={d.maxProducts}
          onChange={(e) => set({ maxProducts: e.target.value })}
        />
        {(plan?.org_kind ?? d.org_kind) === 'supplier' && (
          <TextField
            label="Vagas de destaque no catálogo"
            inputMode="numeric"
            value={d.featured}
            onChange={(e) => set({ featured: e.target.value })}
          />
        )}
        <TextField
          label="Ordem"
          inputMode="numeric"
          value={d.position}
          onChange={(e) => set({ position: e.target.value })}
        />
      </div>
      <TextField
        label="Descrição (opcional)"
        value={d.description}
        onChange={(e) => set({ description: e.target.value })}
      />
      {!isDefault && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={d.active}
            onChange={(e) => set({ active: e.target.checked })}
          />
          Disponível para novas assinaturas
        </label>
      )}
      {!input && (
        <p className="text-muted text-xs">
          Nome de 2 a 60 caracteres; preço a partir de R$ 1,00; números inteiros nos limites.
        </p>
      )}
      <Button type="submit" variant="secondary" disabled={!input} loading={save.isPending}>
        {plan ? 'Salvar' : 'Criar plano'}
      </Button>
      {save.isError && <Alert tone="error">{plansErrorMessage(save.error)}</Alert>}
      {save.isSuccess && plan && (
        <Alert tone="success">
          Salvo. Limites valem na hora; preço novo só para novas assinaturas.
        </Alert>
      )}
    </form>
  );
}

export function PlansAdminPage() {
  const billing = useAdminBilling();
  const [creating, setCreating] = useState(false);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Planos</h1>
        <p className="text-muted text-sm">
          Planos de vendedor e fornecedor, limites e assinaturas pelo Mercado Pago.
        </p>
      </div>
      {billing.isPending ? (
        <PageLoader />
      ) : billing.isError ? (
        <Alert tone="error">{plansErrorMessage(billing.error)}</Alert>
      ) : (
        <>
          <div className="border-border bg-surface grid gap-4 rounded-xl border p-5 sm:grid-cols-2">
            <div>
              <p className="text-muted text-xs">Receita mensal recorrente</p>
              <p className="text-2xl font-semibold tabular-nums">
                {formatBRL(billing.data.monthly_revenue_cents)}
              </p>
            </div>
            <div>
              <p className="text-muted text-xs">Assinaturas ativas</p>
              <p className="text-2xl font-semibold tabular-nums">
                {billing.data.plans.reduce((n, p) => n + p.subscribers, 0)}
              </p>
            </div>
          </div>

          <Section
            title="Planos"
            description="O gratuito de cada tipo é o padrão de toda empresa nova e não pode ser cobrado."
          >
            <ul className="divide-border -mx-5 divide-y">
              {billing.data.plans.map((p) => (
                <li key={p.id} className="space-y-3 px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">
                      {p.name} · {formatPlanPrice(p.price_cents)}
                      {!p.active && <span className="text-muted"> (indisponível)</span>}
                    </p>
                    <span className="text-muted text-xs">
                      {orgKindLabels[p.org_kind]}
                      {p.is_default ? ' · padrão' : ` · ${p.subscribers} assinantes`}
                    </span>
                  </div>
                  <PlanForm plan={p} />
                </li>
              ))}
            </ul>
            <div className="mt-4">
              {creating ? (
                <div className="border-border space-y-3 rounded-lg border p-4">
                  <p className="font-medium">Novo plano pago</p>
                  <PlanForm plan={null} onDone={() => setCreating(false)} />
                </div>
              ) : (
                <Button variant="secondary" onClick={() => setCreating(true)}>
                  <Plus className="size-4" aria-hidden />
                  Novo plano
                </Button>
              )}
            </div>
          </Section>

          <Section title="Assinaturas" description="As 100 mais recentes.">
            {billing.data.subscriptions.length === 0 ? (
              <p className="text-muted text-sm">Nenhuma assinatura ainda.</p>
            ) : (
              <ul className="divide-border -mx-5 divide-y text-sm">
                {billing.data.subscriptions.map((s) => (
                  <li key={s.id} className="flex flex-wrap justify-between gap-3 px-5 py-2">
                    <span>
                      {s.organization_name}
                      <span className="text-muted block text-xs">
                        {orgKindLabels[s.org_kind]} · {s.plan_name} · desde {day(s.created_at)}
                      </span>
                    </span>
                    <span className="text-right">
                      {subscriptionStatusLabels[s.status]}
                      <span className="text-muted block text-xs tabular-nums">
                        {formatBRL(s.price_cents)}/mês
                        {s.next_payment_at && s.status === 'authorized'
                          ? ` · próxima ${day(s.next_payment_at)}`
                          : s.access_until
                            ? ` · vale até ${day(s.access_until)}`
                            : ''}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
