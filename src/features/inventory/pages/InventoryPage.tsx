import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AlertTriangle, Boxes, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { useOrganization } from '@/features/organizations/organization-context';
import { describeAttributes } from '@/features/products/variants';
import { cn } from '@/utils/cn';
import { INVENTORY_PAGE_SIZE, useInventoryLevels, type InventoryFilters } from '../api';
import { inventoryErrorMessage } from '../errors';

function readFilters(params: URLSearchParams): InventoryFilters {
  const page = Number(params.get('pagina'));
  return {
    search: params.get('q') ?? '',
    lowOnly: params.get('baixo') === '1',
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

const quantity = (n: number) => n.toLocaleString('pt-BR');

export function InventoryPage() {
  const { active } = useOrganization();
  const orgId = active!.organization.id; // guaranteed by RequireOrganization

  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const levels = useInventoryLevels(orgId, filters);
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

  const total = levels.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / INVENTORY_PAGE_SIZE));
  const filtered = filters.search !== '' || filters.lowOnly;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Estoque</h1>
        <p className="text-muted mt-1 text-sm">
          Saldo por unidade vendável (produto ou variação). Toda alteração fica registrada no
          histórico.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1">
          <Search
            className="text-muted pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden
          />
          <input
            type="search"
            aria-label="Buscar por produto ou SKU"
            placeholder="Buscar por produto ou SKU"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="border-border bg-surface placeholder:text-muted/70 focus:border-brand focus:ring-brand/30 h-10 w-full rounded-lg border pr-3 pl-9 text-sm outline-none focus:ring-2"
          />
        </div>
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

      {levels.isPending ? (
        <PageLoader />
      ) : levels.isError ? (
        <Alert tone="error">{inventoryErrorMessage(levels.error)}</Alert>
      ) : levels.data.items.length === 0 ? (
        <div className="border-border rounded-xl border border-dashed px-6 py-16 text-center">
          <Boxes className="text-muted mx-auto size-8" aria-hidden />
          <p className="mt-3 font-medium">
            {filtered ? 'Nenhum item encontrado' : 'Nenhum item de estoque'}
          </p>
          <p className="text-muted mt-1 text-sm">
            {filtered ? (
              'Ajuste a busca ou o filtro.'
            ) : (
              <>
                Cada produto cadastrado ganha um saldo aqui.{' '}
                <Link to="/produtos" className="text-brand font-medium hover:underline">
                  Ir para Produtos
                </Link>
              </>
            )}
          </p>
        </div>
      ) : (
        <div
          className={cn(
            'border-border bg-surface overflow-hidden rounded-xl border transition-opacity',
            levels.isPlaceholderData && 'opacity-60',
          )}
        >
          <table className="w-full text-sm">
            <thead className="border-border text-muted border-b text-left text-xs">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  Item
                </th>
                <th scope="col" className="hidden px-4 py-3 font-medium sm:table-cell">
                  SKU
                </th>
                <th scope="col" className="hidden px-4 py-3 text-right font-medium md:table-cell">
                  Físico
                </th>
                <th scope="col" className="hidden px-4 py-3 text-right font-medium md:table-cell">
                  Reservado
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Disponível
                </th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {levels.data.items.map((l) => (
                <tr key={l.id} className={cn('hover:bg-surface-2', !l.is_active && 'opacity-60')}>
                  <td className="max-w-0 px-4 py-3">
                    <Link
                      to={`/estoque/${l.id}`}
                      className="block truncate font-medium hover:underline"
                    >
                      {l.product_name}
                    </Link>
                    {l.attributes && (
                      <span className="text-muted block truncate text-xs">
                        {describeAttributes(l.attributes)}
                      </span>
                    )}
                    <span className="text-muted block truncate font-mono text-xs sm:hidden">
                      {l.sku}
                    </span>
                  </td>
                  <td className="text-muted hidden px-4 py-3 font-mono text-xs sm:table-cell">
                    {l.sku}
                  </td>
                  <td className="hidden px-4 py-3 text-right tabular-nums md:table-cell">
                    {quantity(l.on_hand)}
                  </td>
                  <td className="text-muted hidden px-4 py-3 text-right tabular-nums md:table-cell">
                    {quantity(l.reserved)}
                  </td>
                  <td className="px-4 py-3 text-right font-medium whitespace-nowrap tabular-nums">
                    {l.is_low && (
                      <AlertTriangle
                        className="text-danger mr-1.5 inline size-4 align-[-3px]"
                        aria-label="Estoque baixo"
                      />
                    )}
                    <span className={l.is_low ? 'text-danger' : undefined}>
                      {quantity(l.available)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > INVENTORY_PAGE_SIZE && (
        <nav className="flex items-center justify-between gap-3 text-sm" aria-label="Paginação">
          <span className="text-muted">
            Página {filters.page} de {pages} · {total} itens
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
