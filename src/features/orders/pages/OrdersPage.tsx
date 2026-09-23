import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, Plus, ReceiptText, Search } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Select } from '@/components/ui/Select';
import { useOrganization } from '@/features/organizations/organization-context';
import { orgPermissions } from '@/features/organizations/roles';
import { cn } from '@/utils/cn';
import { formatBRL } from '@/utils/money';
import { ORDERS_PAGE_SIZE, orderErrorMessage, useOrders, type OrderFilters } from '../api';
import { OrderStatusBadge } from '../components/OrderStatusBadge';
import { orderStatuses, orderStatusLabels, type OrderStatus } from '../schemas';

function readFilters(params: URLSearchParams): OrderFilters {
  const status = params.get('status');
  const page = Number(params.get('pagina'));
  return {
    search: params.get('q') ?? '',
    status: orderStatuses.includes(status as OrderStatus) ? (status as OrderStatus) : 'all',
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

export function OrdersPage() {
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const canEdit = orgPermissions.editCatalog(active!.role);

  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const orders = useOrders(orgId, filters);
  const [searchText, setSearchText] = useState(filters.search);

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

  useEffect(() => {
    if (searchText === filters.search) return;
    const t = setTimeout(() => update({ q: searchText.trim() || null, pagina: null }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `update` is recreated each render
  }, [searchText, filters.search]);

  const total = orders.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / ORDERS_PAGE_SIZE));
  const filtered = filters.search !== '' || filters.status !== 'all';

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pedidos</h1>
          <p className="text-muted mt-1 text-sm">
            Pedidos de {active!.organization.name}. Itens de fornecedores são encaminhados na
            confirmação.
          </p>
        </div>
        {canEdit && (
          <Link
            to="/pedidos/novo"
            className="bg-brand text-brand-fg hover:bg-brand/90 inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium"
          >
            <Plus className="size-4" aria-hidden />
            Novo pedido
          </Link>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-56 flex-1">
          <Search
            className="text-muted pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden
          />
          <input
            type="search"
            aria-label="Buscar por número ou cliente"
            placeholder="Buscar por nº ou cliente"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="border-border bg-surface placeholder:text-muted/70 focus:border-brand focus:ring-brand/30 h-10 w-full rounded-lg border pr-3 pl-9 text-sm outline-none focus:ring-2"
          />
        </div>
        <Select
          aria-label="Filtrar por situação"
          value={filters.status}
          onChange={(e) =>
            update({ status: e.target.value === 'all' ? null : e.target.value, pagina: null })
          }
        >
          <option value="all">Todas as situações</option>
          {orderStatuses.map((s) => (
            <option key={s} value={s}>
              {orderStatusLabels[s]}
            </option>
          ))}
        </Select>
      </div>

      {orders.isPending ? (
        <PageLoader />
      ) : orders.isError ? (
        <Alert tone="error">{orderErrorMessage(orders.error)}</Alert>
      ) : orders.data.items.length === 0 ? (
        <div className="border-border rounded-xl border border-dashed px-6 py-16 text-center">
          <ReceiptText className="text-muted mx-auto size-8" aria-hidden />
          <p className="mt-3 font-medium">
            {filtered ? 'Nenhum pedido encontrado' : 'Nenhum pedido ainda'}
          </p>
          <p className="text-muted mt-1 text-sm">
            {filtered
              ? 'Ajuste a busca ou o filtro.'
              : 'Registre pedidos manuais aqui. Pedidos de marketplaces chegarão com as integrações.'}
          </p>
        </div>
      ) : (
        <div
          className={cn(
            'border-border bg-surface overflow-hidden rounded-xl border transition-opacity',
            orders.isPlaceholderData && 'opacity-60',
          )}
        >
          <table className="w-full text-sm">
            <thead className="border-border text-muted border-b text-left text-xs">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  Pedido
                </th>
                <th scope="col" className="hidden px-4 py-3 font-medium sm:table-cell">
                  Data
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Total
                </th>
                <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">
                  Situação
                </th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {orders.data.items.map((o) => (
                <tr key={o.id} className="hover:bg-surface-2">
                  <td className="max-w-0 px-4 py-3">
                    <Link
                      to={`/pedidos/${o.id}`}
                      className="block truncate font-medium hover:underline"
                    >
                      #{o.number} · {o.customer_name}
                    </Link>
                    <span className="text-muted block truncate text-xs">
                      {o.ship_city}/{o.ship_state}
                    </span>
                    <span className="mt-1 md:hidden">
                      <OrderStatusBadge status={o.status} />
                    </span>
                  </td>
                  <td className="text-muted hidden px-4 py-3 whitespace-nowrap sm:table-cell">
                    {new Date(o.created_at).toLocaleDateString('pt-BR')}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">
                    {formatBRL(o.total_cents)}
                  </td>
                  <td className="hidden px-4 py-3 md:table-cell">
                    <OrderStatusBadge status={o.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > ORDERS_PAGE_SIZE && (
        <nav className="flex items-center justify-between gap-3 text-sm" aria-label="Paginação">
          <span className="text-muted">
            Página {filters.page} de {pages} · {total} pedidos
          </span>
          <span className="flex gap-2">
            <Button
              variant="secondary"
              disabled={filters.page <= 1}
              onClick={() => update({ pagina: String(filters.page - 1) })}
              aria-label="Página anterior"
            >
              <ChevronLeft className="size-4" aria-hidden />
            </Button>
            <Button
              variant="secondary"
              disabled={filters.page >= pages}
              onClick={() => update({ pagina: String(filters.page + 1) })}
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
