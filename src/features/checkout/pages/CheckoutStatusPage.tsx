import { useParams } from 'react-router';
import { ExternalLink, Truck } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { CopyField } from '@/components/ui/CopyField';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { formatBRL } from '@/utils/money';
import { useCheckoutOrderStatus } from '../api';
import { BuyerReview } from '../components/BuyerReview';
import {
  checkoutMethodLabels,
  paymentStatusLabels,
  statusHeadline,
  type CheckoutOrderStatus,
} from '../checkout';

const when = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

function PendingPayment({ s }: { s: CheckoutOrderStatus }) {
  if (s.method === 'pix' && s.pix_qr_code) {
    return (
      <div className="space-y-4">
        <p className="text-sm">
          Abra o app do seu banco, escolha pagar com Pix e leia o QR Code ou cole o código.
        </p>
        {s.pix_qr_base64 && (
          <img
            src={`data:image/png;base64,${s.pix_qr_base64}`}
            alt="QR Code do Pix"
            className="mx-auto size-56 rounded-lg bg-white p-2"
          />
        )}
        <CopyField value={s.pix_qr_code} label="Código Pix" />
        {s.expires_at && <p className="text-muted text-xs">Válido até {when(s.expires_at)}.</p>}
      </div>
    );
  }
  if (s.method === 'boleto' && s.boleto_url) {
    return (
      <div className="space-y-3 text-sm">
        <a
          href={s.boleto_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand inline-flex items-center gap-1 font-medium hover:underline"
        >
          Abrir boleto
          <ExternalLink className="size-4" aria-hidden />
        </a>
        <p className="text-muted">
          A compensação leva até 3 dias úteis.
          {s.expires_at && ` Vencimento: ${when(s.expires_at)}.`}
        </p>
      </div>
    );
  }
  return null;
}

export function CheckoutStatusPage() {
  const { token = '' } = useParams();
  const status = useCheckoutOrderStatus(token);
  const s = status.data;

  if (status.isPending) return <PageLoader />;
  if (status.isError) {
    return <Alert tone="error">Não foi possível consultar o pedido. Recarregue a página.</Alert>;
  }
  if (!s) return <Alert tone="info">Pedido não encontrado. Confira o link.</Alert>;

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <p className="text-muted text-sm">
          Pedido #{s.order_number} · {s.store_name}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{statusHeadline(s)}</h1>
      </div>

      {s.payment_status === 'pending' && (
        <Section
          title="Pagamento"
          description="Assim que o pagamento cair, esta página atualiza sozinha."
        >
          <PendingPayment s={s} />
        </Section>
      )}

      <Section
        title="Resumo"
        description="Guarde o endereço desta página para acompanhar o pedido."
      >
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Produto</dt>
            <dd className="text-right">{s.product_name}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Total</dt>
            <dd className="font-semibold tabular-nums">{formatBRL(s.total_cents)}</dd>
          </div>
          {s.method && (
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Forma de pagamento</dt>
              <dd>{checkoutMethodLabels[s.method]}</dd>
            </div>
          )}
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Situação do pagamento</dt>
            <dd>{paymentStatusLabels[s.payment_status]}</dd>
          </div>
        </dl>
      </Section>

      {s.tracking && s.tracking.length > 0 && (
        <Section title="Rastreio" description="Código informado por quem enviou o produto.">
          <ul className="space-y-2 text-sm">
            {s.tracking.map((t) => (
              <li key={t.code} className="flex items-center gap-2">
                <Truck className="text-muted size-4" aria-hidden />
                {t.carrier ?? 'Transportadora'}: <span className="font-mono">{t.code}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <BuyerReview token={token} s={s} />
    </div>
  );
}
