import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, ImageOff, Search, Store } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { cn } from '@/utils/cn';
import { formatBRL } from '@/utils/money';
import { CATALOG_PAGE_SIZE, catalogErrorMessage, useCatalogSearch } from '../catalog';

export function CatalogPage() {
  const [params, setParams] = useSearchParams();
  const search = params.get('q') ?? '';
  const pageParam = Number(params.get('pagina'));
  const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;
  const catalog = useCatalogSearch(search, page);
  const [searchText, setSearchText] = useState(search);

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
    if (searchText === search) return;
    const t = setTimeout(() => update({ q: searchText.trim() || null, pagina: null }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `update` is recreated each render
  }, [searchText, search]);

  const total = catalog.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / CATALOG_PAGE_SIZE));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Catálogo de fornecedores</h1>
        <p className="text-muted mt-1 text-sm">
          Produtos publicados por fornecedores na TheSigns. Importe para o seu catálogo e venda sem
          estoque próprio.
        </p>
      </div>

      <div className="relative max-w-xl">
        <Search
          className="text-muted pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          aria-hidden
        />
        <input
          type="search"
          aria-label="Buscar por produto, marca ou fornecedor"
          placeholder="Buscar por produto, marca ou fornecedor"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          className="border-border bg-surface placeholder:text-muted/70 focus:border-brand focus:ring-brand/30 h-10 w-full rounded-lg border pr-3 pl-9 text-sm outline-none focus:ring-2"
        />
      </div>

      {catalog.isPending ? (
        <PageLoader />
      ) : catalog.isError ? (
        <Alert tone="error">{catalogErrorMessage(catalog.error)}</Alert>
      ) : catalog.data.items.length === 0 ? (
        <div className="border-border rounded-xl border border-dashed px-6 py-16 text-center">
          <Store className="text-muted mx-auto size-8" aria-hidden />
          <p className="mt-3 font-medium">
            {search ? 'Nenhum produto encontrado' : 'Nenhum produto publicado ainda'}
          </p>
          <p className="text-muted mt-1 text-sm">
            {search
              ? 'Tente outro termo.'
              : 'Quando fornecedores publicarem produtos, eles aparecerão aqui.'}
          </p>
        </div>
      ) : (
        <ul
          className={cn(
            'grid grid-cols-2 gap-4 transition-opacity sm:grid-cols-3 lg:grid-cols-4',
            catalog.isPlaceholderData && 'opacity-60',
          )}
        >
          {catalog.data.items.map((item) => (
            <li key={item.listing_id}>
              <Link
                to={`/catalogo/${item.listing_id}`}
                className="border-border bg-surface hover:border-brand/50 block overflow-hidden rounded-xl border transition-colors"
              >
                <div className="bg-surface-2 relative aspect-square">
                  {item.cover_url ? (
                    <img
                      src={item.cover_url}
                      alt=""
                      className="size-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <ImageOff className="text-muted absolute inset-0 m-auto size-6" aria-hidden />
                  )}
                </div>
                <div className="space-y-1 p-3 text-sm">
                  <p className="line-clamp-2 font-medium">{item.name}</p>
                  <p className="text-muted truncate text-xs">{item.supplier_name}</p>
                  <p className="font-semibold tabular-nums">
                    {formatBRL(item.wholesale_price_cents)}
                    <span className="text-muted ml-1 text-xs font-normal">atacado</span>
                  </p>
                  <p className={cn('text-xs', item.available > 0 ? 'text-muted' : 'text-danger')}>
                    {item.available > 0
                      ? `${item.available.toLocaleString('pt-BR')} disponíveis`
                      : 'Sem estoque'}
                    {item.variant_count > 0 && ` · ${item.variant_count} variações`}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {total > CATALOG_PAGE_SIZE && (
        <nav className="flex items-center justify-between gap-3 text-sm" aria-label="Paginação">
          <span className="text-muted">
            Página {page} de {pages} · {total} produtos
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
