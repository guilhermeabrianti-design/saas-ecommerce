import { Alert } from '@/components/ui/Alert';
import { Section } from '@/components/ui/Section';
import { formatBRL } from '@/utils/money';
import { checkoutMethodLabels, commissionSourceLabel, paymentStatusLabels } from '../checkout';
import type { CheckoutPaymentStatus } from '../checkout';

export interface OrderCheckoutInfo {
  payment: {
    method: 'pix' | 'card' | 'boleto' | null;
    status: CheckoutPaymentStatus;
    amount_cents: number;
    expires_at: string | null;
    needs_refund: boolean;
    approved_at: string | null;
  } | null;
  split: {
    seller_commission_bps: number;
    seller_commission_source: string;
    seller_commission_cents: number;
    settled_at: string | null;
  } | null;
}

/** Pedido do checkout: pagamento e comissão (só leitura; quem decide é o pagamento). */
export function CheckoutPaymentSection({ info }: { info: OrderCheckoutInfo }) {
  const { payment, split } = info;
  return (
    <Section
      title="Checkout"
      description="Pago ao Mercado Pago da TheSigns. Pagamento aprovado confirma o pedido e envia ao fornecedor sozinho."
    >
      {!payment ? (
        <p className="text-muted text-sm">Sem dados de pagamento visíveis para o seu papel.</p>
      ) : (
        <div className="space-y-3 text-sm">
          {payment.needs_refund && (
            <Alert tone="info">
              Pagamento aprovado sem condição de seguir: a equipe está estornando.
            </Alert>
          )}
          <dl className="grid gap-2 sm:grid-cols-2">
            <div>
              <dt className="text-muted">Situação</dt>
              <dd className="font-medium">{paymentStatusLabels[payment.status]}</dd>
            </div>
            <div>
              <dt className="text-muted">Forma</dt>
              <dd>{payment.method ? checkoutMethodLabels[payment.method] : '—'}</dd>
            </div>
            {split && (
              <div>
                <dt className="text-muted">
                  Sua comissão ({(split.seller_commission_bps / 100).toLocaleString('pt-BR')}%,{' '}
                  {commissionSourceLabel(split.seller_commission_source)})
                </dt>
                <dd className="text-success font-semibold tabular-nums">
                  {formatBRL(split.seller_commission_cents)}
                  {!split.settled_at && (
                    <span className="text-muted font-normal"> · após o pagamento</span>
                  )}
                </dd>
              </div>
            )}
            {payment.status === 'pending' && payment.expires_at && (
              <div>
                <dt className="text-muted">Vence em</dt>
                <dd>{new Date(payment.expires_at).toLocaleString('pt-BR')}</dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </Section>
  );
}
