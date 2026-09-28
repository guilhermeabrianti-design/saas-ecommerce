import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { TextField } from '@/components/ui/TextField';
import { Pager } from '@/features/admin/components/Pager';
import { orgKindLabels } from '@/features/organizations/roles';
import { cn } from '@/utils/cn';
import { centsToInput, formatBRL } from '@/utils/money';
import {
  affiliateErrorMessage,
  referralStatusLabels,
  validateReferralSettings,
  type ReferralProgram,
  type ReferralSettingsInput,
} from '../affiliates';
import {
  REFERRALS_PAGE_SIZE,
  useAdminReferrals,
  useReferralSettings,
  useReferralsOverview,
  useSaveReferralSettings,
} from '../api';

const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

function SettingsForm({ current }: { current: ReferralProgram }) {
  const save = useSaveReferralSettings();
  const [form, setForm] = useState<ReferralSettingsInput>({
    enabled: current.enabled,
    reward: centsToInput(current.reward_cents),
    min_sale: centsToInput(current.min_sale_cents),
    window_days: String(current.window_days),
  });
  const [submitted, setSubmitted] = useState(false);
  const { values, errors } = validateReferralSettings(form);
  const set = (patch: Partial<ReferralSettingsInput>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
        if (values) save.mutate(values);
      }}
    >
      {save.isError && <Alert tone="error">{affiliateErrorMessage(save.error)}</Alert>}
      {save.isSuccess && (
        <Alert tone="success">Regras salvas. Valem para as próximas indicações.</Alert>
      )}
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => set({ enabled: e.target.checked })}
          className="size-4"
        />
        Programa ligado (aceita novos códigos de indicação)
      </label>
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          label="Recompensa (R$)"
          inputMode="decimal"
          value={form.reward}
          onChange={(e) => set({ reward: e.target.value })}
          error={submitted ? errors.reward : undefined}
          hint="Paga da receita da TheSigns"
        />
        <TextField
          label="Venda mínima (R$)"
          inputMode="decimal"
          value={form.min_sale}
          onChange={(e) => set({ min_sale: e.target.value })}
          error={submitted ? errors.min_sale : undefined}
          hint="Valor da primeira venda paga; 0 = qualquer"
        />
        <TextField
          label="Prazo (dias)"
          inputMode="numeric"
          value={form.window_days}
          onChange={(e) => set({ window_days: e.target.value })}
          error={submitted ? errors.window_days : undefined}
          hint="Da indicação até a primeira venda"
        />
      </div>
      <p className="text-muted text-xs">
        Cada indicação guarda a regra do dia em que foi registrada. Mudanças aqui não alteram
        indicações anteriores.
      </p>
      <Button type="submit" loading={save.isPending}>
        Salvar regras
      </Button>
    </form>
  );
}

function Settings() {
  const settings = useReferralSettings();
  if (settings.isPending) return <PageLoader />;
  if (settings.isError) return <Alert tone="error">{affiliateErrorMessage(settings.error)}</Alert>;
  return <SettingsForm key={JSON.stringify(settings.data)} current={settings.data} />;
}

function Referrals() {
  const overview = useReferralsOverview();
  const [page, setPage] = useState(1);
  const list = useAdminReferrals(page);

  if (overview.isPending || list.isPending) return <PageLoader />;
  if (overview.isError) return <Alert tone="error">{affiliateErrorMessage(overview.error)}</Alert>;
  if (list.isError) return <Alert tone="error">{affiliateErrorMessage(list.error)}</Alert>;
  const o = overview.data;
  const tiles: [string, string][] = [
    ['Indicações', String(o.total)],
    ['Aguardando venda', String(o.waiting)],
    ['Recompensadas', `${o.rewarded} · ${formatBRL(o.rewarded_cents)}`],
  ];

  return (
    <div className="space-y-4">
      <dl className="grid gap-3 sm:grid-cols-3">
        {tiles.map(([label, value]) => (
          <div key={label} className="border-border bg-surface-2 rounded-xl px-4 py-3">
            <dt className="text-muted text-xs">{label}</dt>
            <dd className="text-lg font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {list.data.length === 0 ? (
        <p className="text-muted text-sm">Nenhuma indicação registrada.</p>
      ) : (
        <ul className="divide-border -mx-5 divide-y">
          {list.data.map((r) => (
            <li
              key={r.referred_org_id}
              className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm"
            >
              <div>
                <p className="font-medium">
                  {r.referrer_name} → {r.referred_name}
                </p>
                <p className="text-muted text-xs">
                  {orgKindLabels[r.referred_kind]} · {day(r.created_at)} · prazo {day(r.expires_at)}
                  {r.min_sale_cents > 0 && ` · mínimo ${formatBRL(r.min_sale_cents)}`}
                  {r.reward_order_number != null && ` · pedido #${r.reward_order_number}`}
                </p>
              </div>
              <div className="text-right">
                <span
                  className={cn(
                    'rounded px-2 py-0.5 text-xs font-medium',
                    r.status === 'rewarded'
                      ? 'bg-success/10 text-success'
                      : r.status === 'waiting'
                        ? 'bg-brand/10 text-brand'
                        : 'bg-surface-2 text-muted',
                  )}
                >
                  {referralStatusLabels[r.status]}
                </span>
                <p className="text-muted mt-1 text-xs tabular-nums">{formatBRL(r.reward_cents)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Pager
        page={page}
        total={o.total}
        pageSize={REFERRALS_PAGE_SIZE}
        onPage={setPage}
        noun="indicações"
      />
    </div>
  );
}

export function ReferralsAdminPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Indicações</h1>
        <p className="text-muted text-sm">
          Recompensa para quem traz vendedores e fornecedores. Paga quando a organização indicada
          faz a primeira venda paga pelo checkout, e desfeita se essa venda for estornada.
        </p>
      </div>
      <Section title="Regras do programa" description="Nasce desligado. Tudo fica na auditoria.">
        <Settings />
      </Section>
      <Section title="Indicações registradas" description="Mais recentes primeiro.">
        <Referrals />
      </Section>
    </div>
  );
}
