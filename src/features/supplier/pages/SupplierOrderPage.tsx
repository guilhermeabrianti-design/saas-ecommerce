import { Link, useParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { TextField } from '@/components/ui/TextField';
import { useShippingLabels } from '@/features/labels/api';
import { LabelsSection } from '@/features/labels/components/LabelsSection';
import { latestTracking } from '@/features/labels/labels';
import { SupplierOrderStatusBadge } from '@/features/orders/components/OrderStatusBadge';
import { useOrganization } from '@/features/organizations/organization-context';
import { orgPermissions } from '@/features/organizations/roles';
import { describeAttributes } from '@/features/products/variants';
import { formatCep } from '@/utils/br';
import { formatBRL } from '@/utils/money';
import {
  shipFormSchema,
  supplierOrderErrorMessage,
  useShipSupplierOrder,
  useSupplierOrder,
  type ShipFormValues,
  type SupplierOrderDetail,
} from '../supplier-orders';

function ShipForm({
  order,
  defaults,
}: {
  order: SupplierOrderDetail;
  defaults: { carrier: string | null; tracking_code: string | null } | null;
}) {
  const { active } = useOrganization();
  const ship = useShipSupplierOrder(active!.organization.id, order.id);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ShipFormValues>({
    resolver: zodResolver(shipFormSchema),
    // Rastreio da etiqueta anexada (ex.: gerada pelo marketplace do vendedor).
    defaultValues: {
      carrier: defaults?.carrier ?? '',
      trackingCode: defaults?.tracking_code ?? '',
    },
  });

  return (
    <form noValidate className="space-y-4" onSubmit={handleSubmit((v) => ship.mutate(v))}>
      {ship.isError && <Alert tone="error">{supplierOrderErrorMessage(ship.error)}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Transportadora"
          placeholder="Ex.: Correios"
          error={errors.carrier?.message}
          {...register('carrier')}
        />
        <TextField
          label="Código de rastreio"
          className="font-mono"
          error={errors.trackingCode?.message}
          {...register('trackingCode')}
        />
      </div>
      <p className="text-muted text-sm">
        Ao confirmar, o estoque reservado destes itens é baixado e o vendedor passa a ver o
        rastreio.
      </p>
      <Button type="submit" loading={ship.isPending}>
        Confirmar envio
      </Button>
    </form>
  );
}

function ShipFormWithLabel({ order }: { order: SupplierOrderDetail }) {
  const labels = useShippingLabels({ supplierOrderId: order.id, orderId: null });
  const latest = labels.data ? latestTracking(labels.data) : null;
  return <ShipForm key={latest?.id ?? 'none'} order={order} defaults={latest} />;
}

export function SupplierOrderPage() {
  const { supplierOrderId = '' } = useParams();
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const order = useSupplierOrder(orgId, supplierOrderId);
  const o = order.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        to="/fornecimentos"
        className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Pedidos de fornecimento
      </Link>

      {order.isPending ? (
        <PageLoader />
      ) : order.isError ? (
        <Alert tone="error">{supplierOrderErrorMessage(order.error)}</Alert>
      ) : !o ? (
        <Alert tone="info">Pedido de fornecimento não encontrado nesta organização.</Alert>
      ) : (
        <div key={o.id} className="space-y-6">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Fornecimento #{o.number}</h1>
            <SupplierOrderStatusBadge status={o.status} />
            <Link
              to="/suporte?categoria=order"
              className="text-muted hover:text-fg ml-auto text-sm underline-offset-2 hover:underline"
            >
              Pedir ajuda
            </Link>
          </div>

          <Section title="Itens" description="Separe e envie estes itens.">
            <ul className="divide-border -my-3 divide-y text-sm">
              {o.supplier_order_items.map((it) => (
                <li key={it.id} className="flex items-start gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{it.name}</p>
                    <p className="text-muted truncate text-xs">
                      <span className="font-mono">{it.sku}</span>
                      {it.attributes && ` · ${describeAttributes(it.attributes)}`}
                    </p>
                  </div>
                  <span className="font-medium tabular-nums">{it.quantity} un.</span>
                  <span className="text-muted w-24 text-right tabular-nums">
                    {formatBRL(it.quantity * it.unit_wholesale_cents)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="border-border mt-4 flex justify-between border-t pt-3 text-sm font-semibold">
              <span>Total (atacado)</span>
              <span className="tabular-nums">{formatBRL(o.total_wholesale_cents)}</span>
            </p>
          </Section>

          <Section title="Destinatário" description="Dados de entrega informados pelo vendedor.">
            <div className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <p className="font-medium">{o.recipient_name}</p>
                {o.recipient_phone && <p className="text-muted">{o.recipient_phone}</p>}
                {o.recipient_document && <p className="text-muted">Doc.: {o.recipient_document}</p>}
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
          </Section>

          <Section title="Etiqueta" description="Etiqueta anexada pelo vendedor ou por você.">
            <LabelsSection
              shipment={{ supplierOrderId: o.id, orderId: null }}
              canUpload={o.status !== 'cancelled' && orgPermissions.editCatalog(active!.role)}
              emptyText="Nenhuma etiqueta anexada. Gere na transportadora e anexe, ou aguarde a do vendedor."
            />
          </Section>

          {o.status === 'pending' && orgPermissions.editCatalog(active!.role) && (
            <Section title="Envio" description="Informe a postagem.">
              <ShipFormWithLabel order={o} />
            </Section>
          )}
          {o.status === 'shipped' && (
            <Alert tone="success">
              Enviado em {new Date(o.shipped_at!).toLocaleString('pt-BR')} · {o.carrier}:{' '}
              <span className="font-mono">{o.tracking_code}</span>
            </Alert>
          )}
          {o.status === 'shipped' && (
            <Alert tone={o.paid_at ? 'success' : 'info'}>
              {o.paid_at
                ? `Pago pelo vendedor em ${new Date(o.paid_at).toLocaleString('pt-BR')}.`
                : `Aguardando pagamento do vendedor (${formatBRL(o.total_wholesale_cents)}).`}
            </Alert>
          )}
          {o.status === 'cancelled' && (
            <Alert tone="info">O vendedor cancelou este pedido. A reserva foi liberada.</Alert>
          )}
        </div>
      )}
    </div>
  );
}
