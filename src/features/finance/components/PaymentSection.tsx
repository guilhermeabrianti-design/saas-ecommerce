import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { cn } from '@/utils/cn';
import { centsToInput, formatBRL } from '@/utils/money';
import { financeErrorMessage, useOrderPaymentMutation, useOrderPayments } from '../api';
import {
  emptyPaymentForm,
  paymentFormSchema,
  paymentMethodLabels,
  paymentMethods,
  paymentStatus,
  paymentStatusLabels,
  type PaymentFormValues,
  type PaymentStatus,
} from '../schemas';

export interface PayableOrder {
  id: string;
  status: string;
  total_cents: number;
  paid_cents: number;
  refunded_cents: number;
}

const newRequestId = () => crypto.randomUUID();

const statusTone: Record<PaymentStatus, string> = {
  unpaid: 'bg-surface-2 text-muted',
  partial: 'bg-brand/10 text-brand',
  paid: 'bg-success/10 text-success',
  refunded: 'bg-danger/10 text-danger',
};

export function PaymentStatusBadge({ order }: { order: PayableOrder }) {
  const status = paymentStatus(order);
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        statusTone[status],
      )}
    >
      {paymentStatusLabels[status]}
    </span>
  );
}

function PaymentForm({
  order,
  orgId,
  kind,
}: {
  order: PayableOrder;
  orgId: string;
  kind: 'payment' | 'refund';
}) {
  const mutation = useOrderPaymentMutation(orgId, order.id);
  // Mantido entre tentativas do mesmo envio; renovado só após sucesso, para que
  // duplo clique ou nova tentativa depois de falha de rede não registre duas vezes.
  const [requestId, setRequestId] = useState(newRequestId);
  const net = order.paid_cents - order.refunded_cents;
  const suggested = kind === 'payment' ? order.total_cents - net : net;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentFormSchema),
    defaultValues: { ...emptyPaymentForm, amount: suggested > 0 ? centsToInput(suggested) : '' },
  });

  const onSubmit = handleSubmit((values) =>
    mutation.mutate(
      { kind, values, requestId },
      {
        onSuccess: () => {
          setRequestId(newRequestId());
          reset({ ...emptyPaymentForm, method: values.method });
        },
      },
    ),
  );

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {mutation.isError && <Alert tone="error">{financeErrorMessage(mutation.error)}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Valor (R$)"
          inputMode="decimal"
          autoComplete="off"
          error={errors.amount?.message}
          {...register('amount')}
        />
        <Select label="Forma" {...register('method')}>
          {paymentMethods.map((m) => (
            <option key={m} value={m}>
              {paymentMethodLabels[m]}
            </option>
          ))}
        </Select>
      </div>
      <TextField
        label="Observação (opcional)"
        error={errors.note?.message}
        placeholder={kind === 'refund' ? 'Motivo do estorno' : 'Ex.: comprovante 1234'}
        {...register('note')}
      />
      <Button
        type="submit"
        variant={kind === 'refund' ? 'secondary' : 'primary'}
        loading={mutation.isPending}
      >
        {kind === 'refund' ? 'Registrar estorno' : 'Registrar recebimento'}
      </Button>
    </form>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString('pt-BR');

export function PaymentSection({
  order,
  orgId,
  canEdit,
}: {
  order: PayableOrder;
  orgId: string;
  canEdit: boolean;
}) {
  const payments = useOrderPayments(orgId, order.id);
  const [mode, setMode] = useState<'payment' | 'refund'>('payment');
  const net = order.paid_cents - order.refunded_cents;
  const canReceive = order.status !== 'cancelled' && net < order.total_cents;
  const canRefund = net > 0;
  // Se só uma das ações está disponível, ela é a ativa.
  const active = mode === 'payment' && !canReceive && canRefund ? 'refund' : mode;

  return (
    <Section
      title="Pagamento"
      description="Recebimentos registrados manualmente e estornos deste pedido."
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <PaymentStatusBadge order={order} />
          <span className="text-muted tabular-nums">
            Recebido {formatBRL(net)} de {formatBRL(order.total_cents)}
            {order.refunded_cents > 0 && ` (estornado ${formatBRL(order.refunded_cents)})`}
          </span>
        </div>

        {canEdit && (canReceive || canRefund) && (
          <div className="space-y-4">
            {canReceive && canRefund && (
              <div className="flex gap-2" role="group" aria-label="Tipo de lançamento">
                <Button
                  variant={active === 'payment' ? 'primary' : 'secondary'}
                  onClick={() => setMode('payment')}
                >
                  Receber
                </Button>
                <Button
                  variant={active === 'refund' ? 'primary' : 'secondary'}
                  onClick={() => setMode('refund')}
                >
                  Estornar
                </Button>
              </div>
            )}
            <PaymentForm key={`${active}-${net}`} order={order} orgId={orgId} kind={active} />
          </div>
        )}

        {canEdit &&
          (payments.isPending ? (
            <PageLoader />
          ) : payments.isError ? (
            <Alert tone="error">{financeErrorMessage(payments.error)}</Alert>
          ) : (
            payments.data.length > 0 && (
              <ul className="divide-border border-border divide-y border-t text-sm">
                {payments.data.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-start gap-3 py-3">
                    <span
                      className={cn(
                        'w-28 shrink-0 text-right font-medium tabular-nums',
                        p.kind === 'refund' ? 'text-danger' : 'text-success',
                      )}
                    >
                      {p.kind === 'refund' ? '−' : '+'}
                      {formatBRL(p.amount_cents)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p>
                        {p.kind === 'refund' ? 'Estorno' : 'Recebimento'} ·{' '}
                        {paymentMethodLabels[p.method]}
                      </p>
                      {p.note && <p className="text-muted truncate text-xs">{p.note}</p>}
                    </div>
                    <span className="text-muted text-xs">{when(p.created_at)}</span>
                  </li>
                ))}
              </ul>
            )
          ))}
      </div>
    </Section>
  );
}
