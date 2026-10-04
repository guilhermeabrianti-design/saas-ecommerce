import { Link, useParams } from 'react-router';
import { ArrowLeft, RefreshCw, Truck } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { CheckoutPaymentSection } from '@/features/checkout/components/CheckoutPaymentSection';
import { financeErrorMessage, usePaySupplierOrder } from '@/features/finance/api';
import { useFetchMarketplaceDocuments, useOrderMarketplace } from '@/features/labels/api';
import { documentsButtonLabel, type DocumentsMarketplace } from '@/features/labels/labels';
import { LabelsSection } from '@/features/labels/components/LabelsSection';
import { useMySupplierReviews } from '@/features/reviews/api';
import { SupplierReviewForm } from '@/features/reviews/components/SupplierReviewForm';
import { PaymentSection } from '@/features/finance/components/PaymentSection';
import { useOrganization } from '@/features/organizations/organization-context';
import { orgPermissions } from '@/features/organizations/roles';
import { describeAttributes } from '@/features/products/variants';
import { formatCep } from '@/utils/br';
import { formatBRL } from '@/utils/money';
import { orderErrorMessage, useOrder, useOrderAction, type OrderDetail } from '../api';
import {
  OrderChannelBadge,
  OrderStatusBadge,
  SupplierOrderStatusBadge,
  InTransitBadge,
} from '../components/OrderStatusBadge';
import { inTransit } from '../schemas';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR') : null);

/** Relê o pedido no marketplace e anexa os documentos que já estiverem prontos. */
function MarketplaceDocumentsButton({ orderId }: { orderId: string }) {
  const marketplace = useOrderMarketplace(orderId, true);
  if (!marketplace.data) return null;
  return <DocumentsButton orderId={orderId} marketplace={marketplace.data} />;
}

function DocumentsButton({
  orderId,
  marketplace,
}: {
  orderId: string;
  marketplace: DocumentsMarketplace;
}) {
  const fetchDocs = useFetchMarketplaceDocuments(orderId, marketplace);
  return (
    <div className="space-y-2">
      {fetchDocs.isError && (
        <Alert tone="error">{(fetchDocs.error as { message?: string }).message}</Alert>
      )}
      {fetchDocs.isSuccess && <Alert tone="info">{fetchDocs.data}</Alert>}
      <Button variant="secondary" loading={fetchDocs.isPending} onClick={() => fetchDocs.mutate()}>
        <RefreshCw className="size-4" aria-hidden />
        {documentsButtonLabel(marketplace)}
      </Button>
    </div>
  );
}

function Actions({ order }: { order: OrderDetail }) {
  const { active } = useOrganization();
  const action = useOrderAction(active!.organization.id, order.id);
  const busy = (a: string) => action.isPending && action.variables === a;
  const waitingSupplier = order.supplier_orders.some((s) => s.status !== 'shipped');
  const supplierShipped = order.supplier_orders.some((s) => s.status === 'shipped');
  // Checkout: confirmar e cancelar seguem o pagamento (Mercado Pago), não o vendedor.
  const managed = order.channel === 'checkout';

  return (
    <div className="space-y-3">
      {action.isError && <Alert tone="error">{orderErrorMessage(action.error)}</Alert>}
      <div className="flex flex-wrap gap-2">
        {order.status === 'pending' && !managed && (
          <Button loading={busy('confirm_order')} onClick={() => action.mutate('confirm_order')}>
            Confirmar pedido
          </Button>
        )}
        {order.status === 'confirmed' && (
          <Button
            loading={busy('ship_order')}
            disabled={waitingSupplier}
            onClick={() => action.mutate('ship_order')}
          >
            Marcar como enviado
          </Button>
        )}
        {order.status === 'shipped' && (
          <Button loading={busy('deliver_order')} onClick={() => action.mutate('deliver_order')}>
            Marcar como entregue
          </Button>
        )}
        {(order.status === 'pending' || order.status === 'confirmed') &&
          !supplierShipped &&
          !managed && (
            <ConfirmButton
              confirmLabel="Cancelar pedido"
              loading={busy('cancel_order')}
              onConfirm={() => action.mutate('cancel_order')}
            >
              Cancelar
            </ConfirmButton>
          )}
      </div>
      {order.status === 'pending' && (
        <p className="text-muted text-sm">
          {managed
            ? 'Aguardando o pagamento do cliente. Aprovado, o pedido é confirmado e enviado ao fornecedor.'
            : 'Confirmar reserva o estoque próprio e envia os itens de fornecedor para eles.'}
        </p>
      )}
      {order.status === 'confirmed' && waitingSupplier && (
        <p className="text-muted text-sm">Aguardando o envio dos fornecedores.</p>
      )}
    </div>
  );
}

export function OrderPage() {
  const { orderId = '' } = useParams();
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const canEdit = orgPermissions.editCatalog(active!.role);
  const canFinance = orgPermissions.viewFinance(active!.role);
  const order = useOrder(orgId, orderId);
  const paySupplier = usePaySupplierOrder(orgId);
  const supplierReviews = useMySupplierReviews(orderId, canFinance);
  const payError = paySupplier.isError ? paySupplier.error : null;
  const o = order.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        to="/pedidos"
        className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Pedidos
      </Link>

      {order.isPending ? (
        <PageLoader />
      ) : order.isError ? (
        <Alert tone="error">{orderErrorMessage(order.error)}</Alert>
      ) : !o ? (
        <Alert tone="info">Pedido não encontrado nesta empresa.</Alert>
      ) : (
        <div key={o.id} className="space-y-6">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Pedido #{o.number}</h1>
            <OrderStatusBadge status={o.status} channel={o.channel} />
            <OrderChannelBadge channel={o.channel} />
            {inTransit(o) && <InTransitBadge />}
            <Link
              to={`/suporte?categoria=order&pedido=${o.id}`}
              className="text-muted hover:text-fg ml-auto text-sm underline-offset-2 hover:underline"
            >
              Pedir ajuda com este pedido
            </Link>
          </div>

          {canEdit && o.status !== 'delivered' && o.status !== 'cancelled' && <Actions order={o} />}

          <Section title="Itens" description="Valores registrados no momento do pedido.">
            <ul className="divide-border -my-3 divide-y text-sm">
              {o.order_items.map((it) => (
                <li key={it.id} className="flex items-start gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{it.name}</p>
                    <p className="text-muted truncate text-xs">
                      <span className="font-mono">{it.sku}</span>
                      {it.attributes && ` · ${describeAttributes(it.attributes)}`}
                      {it.fulfillment === 'supplier' && ' · via fornecedor'}
                    </p>
                  </div>
                  <span className="text-muted tabular-nums">
                    {it.quantity} × {formatBRL(it.unit_price_cents)}
                  </span>
                  <span className="w-24 text-right font-medium tabular-nums">
                    {formatBRL(it.quantity * it.unit_price_cents)}
                  </span>
                </li>
              ))}
            </ul>
            <dl className="border-border mt-4 space-y-1 border-t pt-3 text-sm">
              {[
                ['Subtotal', o.subtotal_cents],
                ['Frete', o.shipping_cents],
                ['Desconto', -o.discount_cents],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between">
                  <dt className="text-muted">{label}</dt>
                  <dd className="tabular-nums">{formatBRL(value as number)}</dd>
                </div>
              ))}
              <div className="flex justify-between font-semibold">
                <dt>Total</dt>
                <dd className="tabular-nums">{formatBRL(o.total_cents)}</dd>
              </div>
            </dl>
          </Section>

          {o.channel === 'checkout' ? (
            <CheckoutPaymentSection
              info={{ payment: o.checkout_payments, split: o.order_splits }}
            />
          ) : (
            <PaymentSection order={o} orgId={orgId} canEdit={canFinance} />
          )}

          {o.supplier_orders.length > 0 && (
            <Section
              title="Fornecedores"
              description="Itens enviados diretamente pelos fornecedores ao cliente."
            >
              {payError && <Alert tone="error">{financeErrorMessage(payError)}</Alert>}
              <ul className="divide-border -my-3 divide-y text-sm">
                {o.supplier_orders.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-3 py-3">
                    <Truck className="text-muted size-4" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        Fornecimento #{s.number} · custo {formatBRL(s.total_wholesale_cents)}
                      </p>
                      {s.tracking_code && (
                        <p className="text-muted text-xs">
                          {s.carrier ?? 'Transportadora'}:{' '}
                          <span className="font-mono">{s.tracking_code}</span>
                        </p>
                      )}
                      {s.paid_at && <p className="text-muted text-xs">Pago em {when(s.paid_at)}</p>}
                    </div>
                    <SupplierOrderStatusBadge status={s.status} />
                    {canFinance && s.status === 'shipped' && (
                      <SupplierReviewForm
                        orderId={o.id}
                        supplierOrderId={s.id}
                        existing={supplierReviews.data?.find((r) => r.supplier_order_id === s.id)}
                      />
                    )}
                    {canFinance && s.status === 'shipped' && !s.paid_at && (
                      <ConfirmButton
                        confirmLabel={`Pagar ${formatBRL(s.total_wholesale_cents)}`}
                        loading={paySupplier.isPending && paySupplier.variables === s.id}
                        onConfirm={() => paySupplier.mutate(s.id)}
                      >
                        Registrar pagamento
                      </ConfirmButton>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {o.status !== 'pending' && (
            <Section
              title="Etiquetas e notas fiscais"
              description={
                o.channel === 'marketplace'
                  ? 'Pedidos do Mercado Livre: etiqueta e nota fiscal chegam sozinhas ao fornecedor quando ficam prontas lá. Você também pode anexar manualmente.'
                  : 'Anexe a etiqueta e a nota fiscal para quem envia.'
              }
            >
              <div className="space-y-6">
                {o.channel === 'marketplace' && canEdit && (
                  <MarketplaceDocumentsButton orderId={o.id} />
                )}
                {o.supplier_orders.map((s) => (
                  <div key={s.id} className="space-y-2">
                    <p className="text-sm font-medium">Fornecimento #{s.number}</p>
                    <LabelsSection
                      shipment={{ supplierOrderId: s.id, orderId: null }}
                      canUpload={canEdit && s.status !== 'cancelled'}
                      emptyText="Nenhuma etiqueta. Se o marketplace gerou a etiqueta, anexe aqui para o fornecedor imprimir."
                    />
                  </div>
                ))}
                {(o.order_items.some((i) => i.fulfillment === 'own_stock') ||
                  o.supplier_orders.filter((s) => s.status !== 'cancelled').length > 1) && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium">
                      {o.order_items.some((i) => i.fulfillment === 'own_stock')
                        ? 'Itens do seu estoque'
                        : 'Documentos do pedido (repasse a cada fornecedor)'}
                    </p>
                    <LabelsSection
                      shipment={{ supplierOrderId: null, orderId: o.id }}
                      canUpload={canEdit && o.status !== 'cancelled' && o.status !== 'delivered'}
                      emptyText="Nenhuma etiqueta anexada."
                    />
                  </div>
                )}
              </div>
            </Section>
          )}

          <Section title="Cliente e entrega" description="Dados informados no pedido.">
            <div className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <p className="font-medium">{o.customer_name}</p>
                {o.customer_email && <p className="text-muted">{o.customer_email}</p>}
                {o.customer_phone && <p className="text-muted">{o.customer_phone}</p>}
                {o.customer_document && <p className="text-muted">Doc.: {o.customer_document}</p>}
              </div>
              <div className="text-muted">
                <p>
                  {o.ship_street}, {o.ship_number}
                  {o.ship_complement && ` — ${o.ship_complement}`}
                </p>
                <p>
                  {o.ship_district} · {o.ship_city}/{o.ship_state}
                </p>
                <p>CEP {formatCep(o.ship_postal_code)}</p>
              </div>
            </div>
            {o.notes && <p className="text-muted mt-4 text-sm whitespace-pre-line">{o.notes}</p>}
          </Section>

          <Section title="Histórico" description="Marcos do pedido.">
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              {(
                [
                  ['Criado', o.created_at],
                  ['Confirmado', o.confirmed_at],
                  ['Enviado', o.shipped_at],
                  ['Entregue', o.delivered_at],
                  ['Cancelado', o.cancelled_at],
                ] as const
              )
                .filter(([, v]) => v)
                .map(([label, v]) => (
                  <div key={label}>
                    <dt className="text-muted">{label}</dt>
                    <dd>{when(v)}</dd>
                  </div>
                ))}
            </dl>
          </Section>
        </div>
      )}
    </div>
  );
}
