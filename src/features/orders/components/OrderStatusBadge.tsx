import { cn } from '@/utils/cn';
import {
  orderStatusLabel,
  type OrderChannel,
  orderChannelLabels,
  supplierOrderStatusLabels,
  type OrderStatus,
  type SupplierOrderStatus,
} from '../schemas';

const tone: Record<OrderStatus, string> = {
  pending: 'bg-surface-2 text-muted',
  confirmed: 'bg-brand/10 text-brand',
  shipped: 'bg-brand/10 text-brand',
  delivered: 'bg-success/10 text-success',
  cancelled: 'bg-danger/10 text-danger',
};

const supplierTone: Record<SupplierOrderStatus, string> = {
  pending: 'bg-surface-2 text-muted',
  shipped: 'bg-success/10 text-success',
  cancelled: 'bg-danger/10 text-danger',
};

const base = 'rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap';

export function OrderStatusBadge({
  status,
  channel = 'manual',
}: {
  status: OrderStatus;
  channel?: OrderChannel;
}) {
  return <span className={cn(base, tone[status])}>{orderStatusLabel(status, channel)}</span>;
}

/** Selo de origem do pedido (só para os que não são manuais). */
export function OrderChannelBadge({ channel }: { channel: OrderChannel }) {
  if (channel === 'manual') return null;
  return (
    <span
      className={cn(
        base,
        channel === 'checkout' ? 'bg-success/10 text-success' : 'bg-surface-2 text-muted',
      )}
    >
      {orderChannelLabels[channel]}
    </span>
  );
}

export function SupplierOrderStatusBadge({ status }: { status: SupplierOrderStatus }) {
  return (
    <span className={cn(base, supplierTone[status])}>{supplierOrderStatusLabels[status]}</span>
  );
}
