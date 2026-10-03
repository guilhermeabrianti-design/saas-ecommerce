import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { Check, Gem } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { PageLoader } from '@/components/ui/PageLoader';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Section } from '@/components/ui/Section';
import { useOrganization } from '@/features/organizations/organization-context';
import { cn } from '@/utils/cn';
import { formatBRL } from '@/utils/money';
import {
  useBillingOverview,
  useCancelSubscription,
  useRefreshSubscription,
  useSubscribe,
} from '../api';
import {
  formatPlanPrice,
  paymentStatusLabels,
  planFeatures,
  plansErrorMessage,
  subscriptionNote,
  subscriptionStatusLabels,
  type BillingOverview,
} from '../plans';

const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

function Usage({ o, kind }: { o: BillingOverview; kind: 'seller' | 'supplier' }) {
  const rows: { label: string; used: number; limit: number | null }[] = [
    { label: 'Produtos ativos', used: o.usage.products, limit: o.plan.max_products },
    { label: 'Gerações de IA hoje', used: o.usage.ai_today, limit: o.usage.ai_daily_limit },
  ];
  if (kind === 'supplier') {
    rows.push({
      label: 'Destaques no catálogo',
      used: o.usage.featured,
      limit: o.plan.featured_slots,
    });
  }
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.label} className="space-y-1 text-sm">
          <div className="flex justify-between gap-3">
            <span>{r.label}</span>
            <span className="text-muted tabular-nums">
              {r.used.toLocaleString('pt-BR')}
              {r.limit === null ? ' · sem limite' : ` de ${r.limit.toLocaleString('pt-BR')}`}
            </span>
          </div>
          {r.limit !== null && r.limit > 0 && (
            <ProgressBar percent={Math.min(100, (r.used / r.limit) * 100)} label={r.label} />
          )}
        </li>
      ))}
    </ul>
  );
}

function PlanCards({
  o,
  orgId,
  kind,
}: {
  o: BillingOverview;
  orgId: string;
  kind: 'seller' | 'supplier';
}) {
  const subscribe = useSubscribe(orgId);
  const paid = o.plans.filter((p) => !p.is_default);
  return (
    <div className="space-y-3">
      {subscribe.isError && <Alert tone="error">{plansErrorMessage(subscribe.error)}</Alert>}
      {paid.length === 0 && (
        <p className="text-muted text-sm">
          Nenhum plano pago disponível no momento. A equipe TheSigns avisa quando houver.
        </p>
      )}
      <ul className="grid gap-3 sm:grid-cols-2">
        {o.plans.map((p) => {
          const isCurrent = p.id === o.plan.id;
          const isPending = o.pending?.plan_id === p.id;
          return (
            <li
              key={p.id}
              className={cn(
                'border-border bg-surface flex flex-col gap-3 rounded-xl border p-4',
                isCurrent && 'border-brand ring-brand/30 ring-2',
              )}
            >
              <div>
                <p className="font-semibold">{p.name}</p>
                <p className="text-lg font-semibold tabular-nums">
                  {formatPlanPrice(p.price_cents)}
                </p>
                {p.description && <p className="text-muted text-sm">{p.description}</p>}
              </div>
              <ul className="flex-1 space-y-1 text-sm">
                {planFeatures(p, kind).map((f) => (
                  <li key={f} className="flex gap-2">
                    <Check className="text-success mt-0.5 size-4 shrink-0" aria-hidden />
                    {f}
                  </li>
                ))}
              </ul>
              {isCurrent ? (
                <p className="text-brand text-sm font-medium">Plano atual</p>
              ) : p.is_default ? null : o.can_manage ? (
                <Button
                  variant={isPending ? 'secondary' : 'primary'}
                  loading={subscribe.isPending && subscribe.variables === p.id}
                  disabled={subscribe.isPending}
                  onClick={() =>
                    subscribe.mutate(p.id, {
                      onSuccess: (url) => window.location.assign(url),
                    })
                  }
                >
                  {isPending ? 'Continuar pagamento' : 'Assinar'}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {!o.can_manage && (
        <p className="text-muted text-sm">Só o proprietário da empresa muda o plano.</p>
      )}
      <p className="text-muted text-xs">
        Cobrança mensal no cartão pelo Mercado Pago. Trocar de plano cancela o anterior quando o
        novo for autorizado.
      </p>
    </div>
  );
}

export function PlanPage() {
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const kind = active!.organization.kind;
  const overview = useBillingOverview(orgId);
  const cancel = useCancelSubscription(orgId);
  const refresh = useRefreshSubscription(orgId);
  const [params, setParams] = useSearchParams();
  const returned = params.has('preapproval_id');
  const refreshed = useRef(false);

  // Voltou do Mercado Pago: relê a assinatura sem esperar a notificação.
  useEffect(() => {
    if (!returned || refreshed.current) return;
    refreshed.current = true;
    refresh.mutate(undefined, { onSettled: () => setParams({}, { replace: true }) });
  }, [returned, refresh, setParams]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Plano</h1>
        <p className="text-muted text-sm">
          O plano da sua empresa, o uso dos limites e a cobrança.
        </p>
      </div>
      {overview.isPending ? (
        <PageLoader />
      ) : overview.isError ? (
        <Alert tone="error">{plansErrorMessage(overview.error)}</Alert>
      ) : (
        <>
          {refresh.isPending && <Alert tone="info">Conferindo a assinatura no Mercado Pago…</Alert>}
          <div className="border-border bg-surface space-y-4 rounded-xl border p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-muted text-xs">Plano atual</p>
                <p className="flex items-center gap-2 text-2xl font-semibold">
                  <Gem className="text-brand size-6" aria-hidden />
                  {overview.data.plan.name}
                </p>
              </div>
              <p className="text-lg font-semibold tabular-nums">
                {formatPlanPrice(
                  overview.data.current?.price_cents ?? overview.data.plan.price_cents,
                )}
              </p>
            </div>
            {overview.data.current && (
              <p className="text-sm">
                Assinatura:{' '}
                <strong>{subscriptionStatusLabels[overview.data.current.status]}</strong>.{' '}
                {subscriptionNote(overview.data.current)}
              </p>
            )}
            <Usage o={overview.data} kind={kind} />
            {overview.data.can_manage &&
              overview.data.current &&
              overview.data.current.status !== 'cancelled' && (
                <div className="space-y-2">
                  <ConfirmButton
                    confirmLabel="Cancelar assinatura"
                    loading={cancel.isPending}
                    onConfirm={() => cancel.mutate()}
                  >
                    Cancelar assinatura
                  </ConfirmButton>
                  <p className="text-muted text-xs">
                    O plano continua valendo até a data da próxima cobrança.
                  </p>
                </div>
              )}
            {cancel.isError && <Alert tone="error">{plansErrorMessage(cancel.error)}</Alert>}
          </div>

          {overview.data.pending && (
            <Alert tone="info">
              Assinatura do plano {overview.data.pending.plan_name} aguardando o pagamento no
              Mercado Pago.
              {overview.data.pending.checkout_url && overview.data.can_manage && (
                <>
                  {' '}
                  <a className="underline" href={overview.data.pending.checkout_url}>
                    Continuar pagamento
                  </a>
                </>
              )}
            </Alert>
          )}

          <Section title="Planos" description="Escolha o plano que acompanha o tamanho da empresa.">
            <PlanCards o={overview.data} orgId={orgId} kind={kind} />
          </Section>

          {overview.data.payments.length > 0 && (
            <Section title="Cobranças" description="As últimas cobranças da assinatura.">
              <ul className="divide-border -mx-5 divide-y text-sm">
                {overview.data.payments.map((p) => (
                  <li key={p.external_id} className="flex justify-between gap-3 px-5 py-2">
                    <span>
                      {day(p.debit_date ?? p.created_at)}
                      <span className="text-muted block text-xs">
                        {p.payment_status
                          ? (paymentStatusLabels[p.payment_status] ?? p.payment_status)
                          : 'Agendada'}
                      </span>
                    </span>
                    <span className="tabular-nums">{formatBRL(p.amount_cents)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
