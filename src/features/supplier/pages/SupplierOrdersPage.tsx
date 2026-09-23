import { Link, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, PackageCheck } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Select } from '@/components/ui/Select';
import { SupplierOrderStatusBadge } from '@/features/orders/components/OrderStatusBadge';
import {
  supplierOrderStatuses,
  supplierOrderStatusLabels,
  type SupplierOrderStatus,
} from '@/features/orders/schemas';
import { useOrganization } from '@/features/organizations/organization-context';
import { cn } from '@/utils/cn';
import { formatBRL } from '@/utils/money';
import {
  SUPPLIER_ORDERS_PAGE_SIZE,
  supplierOrderErrorMessage,
  useSupplierOrders,
} from '../supplier-orders';

export function SupplierOrdersPage() {
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const [params, setParams] = useSearchParams();
  const statusParam = params.get('status');
  const status = supplierOrderStatuses.includes(statusParam as SupplierOrderStatus)
    ? (statusParam as SupplierOrderStatus)
    : 'all';
  const pageParam = Number(params.get('pagina'));
  const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;
  const orders = useSupplierOrders(orgId, status, page);

  const update = (patch: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(patch)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true },
    );

  const total = orders.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / SUPPLIER_ORDERS_PAGE_SIZE));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Pedidos de fornecimento</h1>
        <p className="text-muted mt-1 text-sm">
          Pedidos de lojas vendedoras para você enviar diretamente ao cliente final.
        </p>
      </div>

      <Select
        aria-label="Filtrar por situação"
        value={status}
        onChange={(e) =>
          update({ status: e.target.value === 'all' ? null : e.target.value, pagina: null })
        }
      >
        <option value="all">Todas as situações</option>
        {supplierOrderStatuses.map((s) => (
          <option key={s} value={s}>
            {supplierOrderStatusLabels[s]}
          </option>
        ))}
      </Select>

      {orders.isPending ? (
        <PageLoader />
      ) : orders.isError ? (
        <Alert tone="error">{supplierOrderErrorMessage(orders.error)}</Alert>
      ) : orders.data.items.length === 0 ? (
        <div className="border-border rounded-xl border border-dashed px-6 py-16 text-center">
          <PackageCheck className="text-muted mx-auto size-8" aria-hidden />
          <p className="mt-3 font-medium">Nenhum pedido de fornecimento</p>
          <p className="text-muted mt-1 text-sm">
            Eles chegam quando vendedores confirmam pedidos de produtos do seu catálogo.
          </p>
        </div>
      ) : (
        <ul
          className={cn(
            'border-border bg-surface divide-border divide-y rounded-xl border transition-opacity',
            orders.isPlaceholderData && 'opacity-60',
          )}
        >
          {orders.data.items.map((o) => (
            <li key={o.id}>
              <Link
                to={`/fornecimentos/${o.id}`}
                className="hover:bg-surface-2 flex flex-wrap items-center gap-3 px-4 py-3 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    #{o.number} · {o.recipient_name}
                  </p>
                  <p className="text-muted text-xs">
                    {o.ship_city}/{o.ship_state} ·{' '}
                    {new Date(o.created_at).toLocaleDateString('pt-BR')}
                  </p>
                </div>
                <span className="tabular-nums">{formatBRL(o.total_wholesale_cents)}</span>
                <SupplierOrderStatusBadge status={o.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {total > SUPPLIER_ORDERS_PAGE_SIZE && (
        <nav className="flex items-center justify-between gap-3 text-sm" aria-label="Paginação">
          <span className="text-muted">
            Página {page} de {pages}
          </span>
          <span className="flex gap-2">
            <Button
              variant="secondary"
              disabled={page <= 1}
              onClick={() => update({ pagina: String(page - 1) })}
              aria-label="Página anterior"
            >
              <ChevronLeft className="size-4" aria-hidden />
            </Button>
            <Button
              variant="secondary"
              disabled={page >= pages}
              onClick={() => update({ pagina: String(page + 1) })}
              aria-label="Próxima página"
            >
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          </span>
        </nav>
      )}
    </div>
  );
}
