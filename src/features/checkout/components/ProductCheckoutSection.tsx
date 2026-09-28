import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { CopyField } from '@/components/ui/CopyField';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { formatBRL } from '@/utils/money';
import { productCheckoutErrorMessage, useProductCheckout, useSetProductCheckout } from '../api';
import { blockReasonLabels, checkoutLink, commissionSourceLabel } from '../checkout';

const percent = (bps: number) =>
  `${(bps / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;

export function ProductCheckoutSection({
  productId,
  canEdit,
}: {
  productId: string;
  canEdit: boolean;
}) {
  const summary = useProductCheckout(productId);
  const toggle = useSetProductCheckout(productId);
  const s = summary.data;

  return (
    <Section
      title="Checkout próprio"
      description="Link de compra com Pix, cartão e boleto. A TheSigns recebe pelo Mercado Pago e repassa fornecedor e comissão."
    >
      {summary.isPending ? (
        <PageLoader />
      ) : summary.isError || !s ? (
        <Alert tone="error">Não foi possível carregar o checkout deste produto.</Alert>
      ) : (
        <div className="space-y-4 text-sm">
          {s.block_reason && <Alert tone="info">{blockReasonLabels[s.block_reason]}</Alert>}

          {s.quote && (
            <dl className="grid gap-2 sm:grid-cols-2">
              <div>
                <dt className="text-muted">Preço de venda (1 unidade)</dt>
                <dd className="font-medium tabular-nums">{formatBRL(s.quote.unit_price_cents)}</dd>
              </div>
              <div>
                <dt className="text-muted">
                  Sua comissão ({percent(s.quote.seller_commission_bps)},{' '}
                  {commissionSourceLabel(s.quote.seller_commission_source)})
                </dt>
                <dd className="text-success font-semibold tabular-nums">
                  {formatBRL(s.quote.seller_commission_cents)}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Fornecedor</dt>
                <dd className="tabular-nums">{formatBRL(s.quote.supplier_cents)}</dd>
              </div>
              <div>
                <dt className="text-muted">TheSigns (antes da taxa do Mercado Pago)</dt>
                <dd className="tabular-nums">{formatBRL(s.quote.platform_before_fee_cents)}</dd>
              </div>
            </dl>
          )}
          <p className="text-muted text-xs">
            A comissão vale para a variação mais barata; em cada venda ela é calculada sobre o valor
            pago e fica registrada no pedido. Frete incluso no preço.
          </p>

          {s.enabled && !s.block_reason && (
            <div className="space-y-1.5">
              <p className="font-medium">Link para divulgar</p>
              <CopyField
                value={checkoutLink(window.location.origin, productId)}
                label="Link do checkout"
              />
            </div>
          )}
          {s.enabled && s.block_reason && (
            <Alert tone="info">
              O checkout está ligado, mas o link fica fora do ar até resolver o aviso acima.
            </Alert>
          )}

          {toggle.isError && (
            <Alert tone="error">{productCheckoutErrorMessage(toggle.error)}</Alert>
          )}
          {canEdit && (
            <Button
              variant={s.enabled ? 'secondary' : 'primary'}
              loading={toggle.isPending}
              disabled={!s.enabled && Boolean(s.block_reason)}
              onClick={() => toggle.mutate(!s.enabled)}
            >
              {s.enabled ? 'Desligar checkout' : 'Ligar checkout'}
            </Button>
          )}
        </div>
      )}
    </Section>
  );
}
