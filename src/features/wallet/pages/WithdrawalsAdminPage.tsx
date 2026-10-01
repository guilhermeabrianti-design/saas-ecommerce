import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { CopyField } from '@/components/ui/CopyField';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { orgKindLabels } from '@/features/organizations/roles';
import { formatDocument } from '@/utils/br';
import { centsToInput, formatBRL, parseBRL } from '@/utils/money';
import {
  useAdminWithdrawalAction,
  useAdminWithdrawals,
  useSaveWalletSettings,
  useWalletSettings,
  useWithdrawalsOverview,
  WITHDRAWALS_PAGE_SIZE,
  type AdminWithdrawal,
  type AdminWithdrawalFilter,
  type WalletSettings,
} from '../api';
import { pixKeyTypeLabels, walletErrorMessage, withdrawalStatusLabels } from '../wallet';

const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

function Overview() {
  const overview = useWithdrawalsOverview();
  if (overview.isPending) return <PageLoader />;
  if (overview.isError) return <Alert tone="error">{walletErrorMessage(overview.error)}</Alert>;
  const o = overview.data;
  const tiles: [string, string][] = [
    ['A conferir', `${o.requested_count} · ${formatBRL(o.requested_cents)}`],
    ['Aprovados a pagar', `${o.approved_count} · ${formatBRL(o.approved_cents)}`],
    ['Pagos (30 dias)', formatBRL(o.paid_30d_cents)],
  ];
  return (
    <dl className="grid gap-3 sm:grid-cols-3">
      {tiles.map(([label, value]) => (
        <div key={label} className="border-border bg-surface rounded-xl border p-4">
          <dt className="text-muted text-xs">{label}</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function WithdrawalActions({ w }: { w: AdminWithdrawal }) {
  const action = useAdminWithdrawalAction();
  const [mode, setMode] = useState<'idle' | 'reject' | 'pay'>('idle');
  const [text, setText] = useState('');

  if (w.status !== 'requested' && w.status !== 'approved') return null;

  const submit = () =>
    action.mutate(
      mode === 'reject'
        ? { kind: 'reject', id: w.id, reason: text.trim() }
        : { kind: 'pay', id: w.id, reference: text.trim() },
      { onSuccess: () => setMode('idle') },
    );

  return (
    <div className="space-y-2">
      {action.isError && <Alert tone="error">{walletErrorMessage(action.error)}</Alert>}
      {mode === 'idle' ? (
        <div className="flex flex-wrap gap-2">
          {w.status === 'requested' && (
            <Button
              loading={action.isPending}
              disabled={w.available_cents < 0 || w.organization_suspended}
              onClick={() => action.mutate({ kind: 'approve', id: w.id })}
            >
              Aprovar
            </Button>
          )}
          {w.status === 'approved' && (
            <Button
              onClick={() => {
                setText('');
                setMode('pay');
              }}
            >
              Registrar pagamento
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => {
              setText('');
              setMode('reject');
            }}
          >
            Recusar
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="min-w-64 flex-1">
            <TextField
              label={
                mode === 'pay'
                  ? 'Identificador da transferência no Mercado Pago'
                  : 'Motivo da recusa (o vendedor vê)'
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={mode === 'pay' ? 120 : 500}
              autoFocus
            />
          </div>
          <Button
            type="submit"
            variant={mode === 'reject' ? 'danger' : 'primary'}
            loading={action.isPending}
            disabled={text.trim().length < 3}
          >
            {mode === 'pay' ? `Confirmar pagamento de ${formatBRL(w.amount_cents)}` : 'Recusar'}
          </Button>
          <Button variant="ghost" onClick={() => setMode('idle')}>
            Voltar
          </Button>
        </form>
      )}
    </div>
  );
}

function WithdrawalRow({ w }: { w: AdminWithdrawal }) {
  const open = w.status === 'requested' || w.status === 'approved';
  return (
    <li className="space-y-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">
            {formatBRL(w.amount_cents)} · {w.organization_name}{' '}
            <span className="text-muted text-xs">({orgKindLabels[w.organization_kind]})</span>
          </p>
          <p className="text-muted text-xs">
            {withdrawalStatusLabels[w.status]} · solicitado em {day(w.created_at)}
            {w.paid_at && ` · pago em ${day(w.paid_at)} (${w.payout_reference})`}
            {w.rejection_reason && ` · ${w.rejection_reason}`}
          </p>
        </div>
        {open && (
          <p className="text-right text-xs">
            Disponível após este saque:{' '}
            <strong className={w.available_cents < 0 ? 'text-danger' : undefined}>
              {formatBRL(w.available_cents)}
            </strong>
          </p>
        )}
      </div>
      {open && w.organization_suspended && (
        <Alert tone="error">Empresa suspensa: não aprove nem pague este saque.</Alert>
      )}
      {open && (
        <div className="grid gap-3 sm:grid-cols-3">
          {(
            [
              [`Chave PIX (${pixKeyTypeLabels[w.pix_key_type]})`, w.pix_key],
              ['Titular', w.holder_name],
              ['CPF/CNPJ do titular', formatDocument(w.holder_document)],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="space-y-1">
              <p className="text-muted text-xs">{label}</p>
              <CopyField label={label} value={value} />
            </div>
          ))}
        </div>
      )}
      <WithdrawalActions w={w} />
    </li>
  );
}

function SettingsForm({ current }: { current: WalletSettings }) {
  const save = useSaveWalletSettings();
  const [delivery, setDelivery] = useState(String(current.release_days_after_delivery));
  const [shipping, setShipping] = useState(String(current.release_days_after_shipping));
  const [min, setMin] = useState(centsToInput(current.min_withdrawal_cents));
  const d = Number(delivery);
  const s = Number(shipping);
  const m = parseBRL(min);
  const valid =
    Number.isInteger(d) &&
    d >= 0 &&
    d <= 90 &&
    Number.isInteger(s) &&
    s >= 1 &&
    s <= 180 &&
    m !== null &&
    m >= 100;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) {
          save.mutate({
            release_days_after_delivery: d,
            release_days_after_shipping: s,
            min_withdrawal_cents: m,
          });
        }
      }}
    >
      {save.isError && <Alert tone="error">{walletErrorMessage(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">Regras salvas.</Alert>}
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          label="Dias após a entrega"
          inputMode="numeric"
          hint="0 a 90"
          value={delivery}
          onChange={(e) => setDelivery(e.target.value)}
        />
        <TextField
          label="Dias após o envio do fornecedor"
          inputMode="numeric"
          hint="1 a 180 · vale se a entrega não for marcada antes"
          value={shipping}
          onChange={(e) => setShipping(e.target.value)}
        />
        <TextField
          label="Saque mínimo (R$)"
          inputMode="decimal"
          hint="A partir de R$ 1,00"
          value={min}
          onChange={(e) => setMin(e.target.value)}
        />
      </div>
      <Button type="submit" loading={save.isPending} disabled={!valid}>
        Salvar regras
      </Button>
    </form>
  );
}

function Settings() {
  const settings = useWalletSettings();
  if (settings.isPending) return <PageLoader />;
  if (settings.isError) return <Alert tone="error">{walletErrorMessage(settings.error)}</Alert>;
  return <SettingsForm key={JSON.stringify(settings.data)} current={settings.data} />;
}

export function WithdrawalsAdminPage() {
  const [filter, setFilter] = useState<AdminWithdrawalFilter>('open');
  const [page, setPage] = useState(1);
  const list = useAdminWithdrawals(filter, page);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Saques</h1>
        <p className="text-muted text-sm">
          Confira o titular, aprove, faça o PIX pela conta Mercado Pago da plataforma e registre o
          identificador da transferência. O débito entra no livro-razão só no registro do pagamento.
        </p>
      </div>

      <Overview />

      <Section title="Solicitações" description="Abertas: mais antigas primeiro.">
        <div className="mb-2 max-w-xs">
          <Select
            aria-label="Filtro"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as AdminWithdrawalFilter);
              setPage(1);
            }}
          >
            <option value="open">Abertas</option>
            <option value="paid">Pagas</option>
            <option value="closed">Recusadas e canceladas</option>
            <option value="all">Todas</option>
          </Select>
        </div>
        {list.isPending ? (
          <PageLoader />
        ) : list.isError ? (
          <Alert tone="error">{walletErrorMessage(list.error)}</Alert>
        ) : list.data.length === 0 ? (
          <p className="text-muted text-sm">Nenhuma solicitação.</p>
        ) : (
          <ul className="divide-border divide-y text-sm">
            {list.data.map((w) => (
              <WithdrawalRow key={w.id} w={w} />
            ))}
          </ul>
        )}
        <div className="mt-4 flex justify-between">
          <Button variant="secondary" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
            Anteriores
          </Button>
          <Button
            variant="secondary"
            disabled={(list.data?.length ?? 0) < WITHDRAWALS_PAGE_SIZE}
            onClick={() => setPage((p) => p + 1)}
          >
            Próximos
          </Button>
        </div>
      </Section>

      <Section
        title="Regras da carteira"
        description="Prazo de garantia antes de liberar cada venda e valor mínimo de saque."
      >
        <Settings />
      </Section>
    </div>
  );
}
