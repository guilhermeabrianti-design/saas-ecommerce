import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Package,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Select } from '@/components/ui/Select';
import { useOrganization } from '@/features/organizations/organization-context';
import { orgPermissions } from '@/features/organizations/roles';
import { cn } from '@/utils/cn';
import { formatBRL } from '@/utils/money';
import { PRODUCTS_PAGE_SIZE, useProducts, type ProductFilters, type ProductStock } from '../api';
import { productErrorMessage } from '../errors';
import { productStatuses, productStatusLabels, type ProductStatus } from '../schemas';

const statusTone: Record<ProductStatus, string> = {
  draft: 'bg-surface-2 text-muted',
  active: 'bg-success/10 text-success',
  archived: 'bg-danger/10 text-danger',
};

export function StatusBadge({ status }: { status: ProductStatus }) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        statusTone[status],
      )}
    >
      {productStatusLabels[status]}
    </span>
  );
}

/** Disponível na lista; importado mostra o estoque do fornecedor no produto. */
function StockCell({ stock }: { stock: ProductStock | null }) {
  if (!stock) return <span className="text-muted">—</span>;
  if (stock.dropship) return <span className="text-muted text-xs">Fornecedor</span>;
  return (
    <span className={cn('tabular-nums', stock.low && 'text-danger font-medium')}>
      {stock.low && (
        <AlertTriangle className="mr-1 inline size-4 align-[-3px]" aria-label="Estoque baixo" />
      )}
      {stock.available.toLocaleString('pt-BR')}
    </span>
  );
}

function readFilters(params: URLSearchParams): ProductFilters {
  const status = params.get('status');
  const page = Number(params.get('pagina'));
  return {
    search: params.get('q') ?? '',
    status: productStatuses.includes(status as ProductStatus) ? (status as ProductStatus) : 'all',
    lowOnly: params.get('baixo') === '1',
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

export function ProductsPage() {
  const { active } = useOrganization();
  const orgId = active!.organization.id; // guaranteed by RequireOrganization
  const canEdit = orgPermissions.editCatalog(active!.role);

  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const products = useProducts(orgId, filters);
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

  // Debounced search: typing updates the URL (and the query) after a short pause.
  useEffect(() => {
    if (searchText === filters.search) return;
    const t = setTimeout(() => update({ q: searchText.trim() || null, pagina: null }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `update` is recreated each render
  }, [searchText, filters.search]);

  const total = products.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PRODUCTS_PAGE_SIZE));
  const filtered = filters.search !== '' || filters.status !== 'all' || filters.lowOnly;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Produtos</h1>
          <p className="text-muted mt-1 text-sm">
            Seus produtos e o estoque de cada um. Abra o produto para ajustar o estoque, ver o
            histórico e anunciar nos marketplaces.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <Link
              to="/produtos/sincronizar-estoque"
              className="border-border hover:bg-surface-2 inline-flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-medium"
            >
              <RefreshCw className="size-4" aria-hidden />
              Sincronizar estoque
            </Link>
          )}
          {canEdit && (
            <Link
              to="/produtos/novo"
              className="bg-brand text-brand-fg hover:bg-brand/90 inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium"
            >
              <Plus className="size-4" aria-hidden />
              Novo produto
            </Link>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-56 flex-1">
          <Search
            className="text-muted pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden
          />
          <input
            type="search"
            aria-label="Buscar por nome ou SKU"
            placeholder="Buscar por nome ou SKU"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="border-border bg-surface placeholder:text-muted/70 focus:border-brand focus:ring-brand/30 h-10 w-full rounded-lg border pr-3 pl-9 text-sm outline-none focus:ring-2"
          />
        </div>
        <Select
          aria-label="Filtrar por status"
          value={filters.status}
          onChange={(e) =>
            update({ status: e.target.value === 'all' ? null : e.target.value, pagina: null })
          }
        >
          <option value="all">Todos os status</option>
          {productStatuses.map((s) => (
            <option key={s} value={s}>
              {productStatusLabels[s]}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={filters.lowOnly}
            onChange={(e) => update({ baixo: e.target.checked ? '1' : null, pagina: null })}
            className="accent-brand size-4"
          />
          Só estoque baixo
        </label>
      </div>

      {products.isPending ? (
        <PageLoader />
      ) : products.isError ? (
        <Alert tone="error">{productErrorMessage(products.error)}</Alert>
      ) : products.data.items.length === 0 ? (
        <div className="border-border rounded-xl border border-dashed px-6 py-16 text-center">
          <Package className="text-muted mx-auto size-8" aria-hidden />
          <p className="mt-3 font-medium">
            {filtered ? 'Nenhum produto encontrado' : 'Nenhum produto cadastrado'}
          </p>
          <p className="text-muted mt-1 text-sm">
            {filtered
              ? 'Ajuste a busca ou os filtros.'
              : canEdit
                ? 'Cadastre o primeiro produto do seu catálogo.'
                : 'Proprietários e administradores podem cadastrar produtos.'}
          </p>
        </div>
      ) : (
        <div
          className={cn(
            'border-border bg-surface overflow-hidden rounded-xl border transition-opacity',
            products.isPlaceholderData && 'opacity-60',
          )}
        >
          <table className="w-full text-sm">
            <thead className="border-border text-muted border-b text-left text-xs">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  Produto
                </th>
                <th scope="col" className="hidden px-4 py-3 font-medium sm:table-cell">
                  SKU
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Preço
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Estoque
                </th>
                <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {products.data.items.map((p) => (
                <tr key={p.id} className="hover:bg-surface-2">
                  <td className="max-w-0 px-4 py-3">
                    <Link
                      to={`/produtos/${p.id}`}
                      className="block truncate font-medium hover:underline"
                    >
                      {p.name}
                    </Link>
                    <span className="text-muted block truncate text-xs sm:hidden">{p.sku}</span>
                    {p.brand && (
                      <span className="text-muted hidden truncate text-xs sm:block">{p.brand}</span>
                    )}
                  </td>
                  <td className="text-muted hidden px-4 py-3 font-mono text-xs sm:table-cell">
                    {p.sku}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">
                    {formatBRL(p.price_cents)}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <StockCell stock={p.stock} />
                  </td>
                  <td className="hidden px-4 py-3 md:table-cell">
                    <StatusBadge status={p.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > PRODUCTS_PAGE_SIZE && (
        <nav className="flex items-center justify-between gap-3 text-sm" aria-label="Paginação">
          <span className="text-muted">
            Página {filters.page} de {pages} · {total} produtos
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
