import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { useOrganization } from '@/features/organizations/organization-context';
import { orgPermissions } from '@/features/organizations/roles';
import { cn } from '@/utils/cn';
import { centsToInput, formatBRL } from '@/utils/money';
import {
  useCancelWithdrawal,
  useRequestWithdrawal,
  useWalletPending,
  useWalletSummary,
  useWithdrawals,
} from '../api';
import {
  maskPixKey,
  pixKeyTypeLabels,
  pixKeyTypes,
  walletErrorMessage,
  withdrawalFormSchema,
  withdrawalStatusLabels,
  type WalletSummary,
  type WithdrawalFormValues,
  type WithdrawalStatus,
} from '../wallet';

const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');
const newRequestId = () => crypto.randomUUID();

function Balances({ s }: { s: WalletSummary }) {
  const tiles: { label: string; value: number; hint: string; tone?: 'good' | 'bad' }[] = [
    {
      label: 'Disponível para saque',
      value: s.available_cents,
      hint: 'Liberado − sacado − em saque',
      tone: s.available_cents < 0 ? 'bad' : 'good',
    },
    { label: 'Pendente', value: s.pending_cents, hint: 'Vendas no prazo de garantia' },
    { label: 'Bloqueado', value: s.blocked_cents, hint: 'Saques solicitados e não pagos' },
    { label: 'Total sacado', value: s.withdrawn_cents, hint: 'Saques já pagos' },
  ];
  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="border-border bg-surface rounded-xl border px-4 py-3">
          <dt className="text-muted text-xs">{t.label}</dt>
          <dd
            className={cn(
              'text-2xl font-semibold tabular-nums',
              t.tone === 'bad' && 'text-danger',
              t.tone === 'good' && 'text-success',
            )}
          >
            {formatBRL(t.value)}
          </dd>
          <p className="text-muted mt-1 text-xs">{t.hint}</p>
        </div>
      ))}
    </dl>
  );
}

function WithdrawalForm({ orgId, summary }: { orgId: string; summary: WalletSummary }) {
  const mutation = useRequestWithdrawal(orgId);
  // Mantido entre tentativas; renovado só após sucesso (evita saque duplicado).
  const [requestId, setRequestId] = useState(newRequestId);
  const [done, setDone] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors },
  } = useForm<WithdrawalFormValues>({
    resolver: zodResolver(
      withdrawalFormSchema(summary.min_withdrawal_cents, summary.available_cents),
    ),
    defaultValues: {
      amount: centsToInput(summary.available_cents),
      pix_key_type: 'cpf',
      pix_key: '',
      holder_name: '',
      holder_document: '',
    },
  });
  const keyType = useWatch({ control, name: 'pix_key_type' });

  if (summary.available_cents < summary.min_withdrawal_cents) {
    return (
      <p className="text-muted text-sm">
        O saque mínimo é de {formatBRL(summary.min_withdrawal_cents)}. Quando o disponível chegar a
        esse valor, você poderá solicitar aqui.
      </p>
    );
  }

  const onSubmit = handleSubmit((values) => {
    setDone(false);
    mutation.mutate(
      { values, requestId },
      {
        onSuccess: () => {
          setRequestId(newRequestId());
          setDone(true);
          reset({ ...values, amount: '' });
        },
      },
    );
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {mutation.isError && <Alert tone="error">{walletErrorMessage(mutation.error)}</Alert>}
      {done && (
        <Alert tone="success">
          Saque solicitado. A equipe confere os dados e faz o PIX pelo Mercado Pago.
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          label="Valor (R$)"
          inputMode="decimal"
          autoComplete="off"
          hint={`Mínimo ${formatBRL(summary.min_withdrawal_cents)} · até ${formatBRL(summary.available_cents)}`}
          error={errors.amount?.message}
          {...register('amount')}
        />
        <Select label="Tipo de chave PIX" {...register('pix_key_type')}>
          {pixKeyTypes.map((t) => (
            <option key={t} value={t}>
              {pixKeyTypeLabels[t]}
            </option>
          ))}
        </Select>
        <TextField
          label="Chave PIX"
          autoComplete="off"
          inputMode={keyType === 'email' || keyType === 'random' ? 'text' : 'numeric'}
          error={errors.pix_key?.message}
          {...register('pix_key')}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Nome do titular"
          autoComplete="name"
          error={errors.holder_name?.message}
          {...register('holder_name')}
        />
        <TextField
          label="CPF/CNPJ do titular"
          inputMode="numeric"
          autoComplete="off"
          error={errors.holder_document?.message}
          {...register('holder_document')}
        />
      </div>
      <Button type="submit" loading={mutation.isPending}>
        Solicitar saque
      </Button>
    </form>
  );
}

const statusTone: Record<WithdrawalStatus, string> = {
  requested: 'bg-brand/10 text-brand',
  approved: 'bg-brand/10 text-brand',
  paid: 'bg-success/10 text-success',
  rejected: 'bg-danger/10 text-danger',
  cancelled: 'bg-surface-2 text-muted',
};

function Withdrawals({ orgId, canCancel }: { orgId: string; canCancel: boolean }) {
  const list = useWithdrawals(orgId);
  const cancel = useCancelWithdrawal(orgId);

  if (list.isPending) return <PageLoader />;
  if (list.isError) return <Alert tone="error">{walletErrorMessage(list.error)}</Alert>;
  if (list.data.length === 0) return <p className="text-muted text-sm">Nenhum saque ainda.</p>;

  return (
    <div className="space-y-3">
      {cancel.isError && <Alert tone="error">{walletErrorMessage(cancel.error)}</Alert>}
      <ul className="divide-border -my-3 divide-y text-sm">
        {list.data.map((w) => (
          <li key={w.id} className="flex flex-wrap items-center gap-3 py-3">
            <span className="w-28 shrink-0 text-right font-medium tabular-nums">
              {formatBRL(w.amount_cents)}
            </span>
            <div className="min-w-0 flex-1">
              <p>
                PIX {pixKeyTypeLabels[w.pix_key_type]} {maskPixKey(w.pix_key_type, w.pix_key)} ·{' '}
                {w.holder_name}
              </p>
              <p className="text-muted text-xs">
                Solicitado em {day(w.created_at)}
                {w.paid_at && ` · pago em ${day(w.paid_at)} (${w.payout_reference})`}
                {w.rejection_reason && ` · ${w.rejection_reason}`}
              </p>
            </div>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
                statusTone[w.status],
              )}
            >
              {withdrawalStatusLabels[w.status]}
            </span>
            {canCancel && w.status === 'requested' && (
              <ConfirmButton
                confirmLabel="Cancelar saque"
                loading={cancel.isPending && cancel.variables === w.id}
                onConfirm={() => cancel.mutate(w.id)}
              >
                Cancelar
              </ConfirmButton>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Pending({ orgId }: { orgId: string }) {
  const pending = useWalletPending(orgId);
  if (pending.isPending) return <PageLoader />;
  if (pending.isError) return <Alert tone="error">{walletErrorMessage(pending.error)}</Alert>;
  if (pending.data.length === 0) {
    return <p className="text-muted text-sm">Nenhuma venda no prazo de garantia.</p>;
  }
  return (
    <ul className="divide-border -my-3 divide-y text-sm">
      {pending.data.map((p) => (
        <li key={p.order_id} className="flex flex-wrap items-start gap-3 py-3">
          <span
            className={cn(
              'w-28 shrink-0 text-right font-medium tabular-nums',
              p.amount_cents < 0 && 'text-danger',
            )}
          >
            {formatBRL(p.amount_cents)}
          </span>
          <p className="min-w-0 flex-1 truncate">{p.description ?? 'Venda pelo checkout'}</p>
          <span className="text-muted text-xs">
            {p.release_at ? `Libera em ${day(p.release_at)}` : 'Aguardando envio'}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function WalletPage() {
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const allowed = orgPermissions.viewFinance(active!.role);
  const summary = useWalletSummary(orgId);

  if (!allowed) {
    return (
      <div className="mx-auto max-w-3xl">
        <Alert tone="info">A carteira é visível apenas para proprietários e administradores.</Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Carteira</h1>
        <p className="text-muted text-sm">
          Valores das vendas pelo checkout da plataforma. Recebimentos registrados manualmente ficam
          só no Financeiro.
        </p>
      </div>

      {summary.isPending ? (
        <PageLoader />
      ) : summary.isError ? (
        <Alert tone="error">{walletErrorMessage(summary.error)}</Alert>
      ) : (
        <>
          <Balances s={summary.data} />
          {summary.data.available_cents < 0 && (
            <Alert tone="error">
              Um estorno ou contestação chegou depois da liberação. Novas vendas cobrem a diferença
              antes de um novo saque.
            </Alert>
          )}
          <p className="text-muted text-xs">
            Cada venda é liberada {summary.data.release_days_after_delivery} dias após a entrega ou{' '}
            {summary.data.release_days_after_shipping} dias após o envio do fornecedor, o que vier
            primeiro.
          </p>

          <Section
            title="Solicitar saque"
            description="Pago por PIX pela conta Mercado Pago da plataforma, após conferência da equipe."
          >
            {summary.data.can_withdraw ? (
              <WithdrawalForm orgId={orgId} summary={summary.data} />
            ) : (
              <p className="text-muted text-sm">
                Só o proprietário da organização pode solicitar saques.
              </p>
            )}
          </Section>
          <Section title="Saques" description="Mais recentes primeiro.">
            <Withdrawals orgId={orgId} canCancel={summary.data.can_withdraw} />
          </Section>
        </>
      )}

      <Section title="Em garantia" description="Vendas ainda não liberadas, por pedido.">
        <Pending orgId={orgId} />
      </Section>
    </div>
  );
}
