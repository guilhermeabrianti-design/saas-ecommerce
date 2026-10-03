import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, ChevronLeft, ChevronRight, ImageOff, Search, Star, Store } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { cn } from '@/utils/cn';
import { formatBRL } from '@/utils/money';
import {
  CATALOG_PAGE_SIZE,
  catalogErrorMessage,
  useCatalogSearch,
  useCatalogSuppliers,
} from '../catalog';

function useUrlState() {
  const [params, setParams] = useSearchParams();
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
  const pageParam = Number(params.get('pagina'));
  const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;
  return { params, update, page };
}

function Pager({
  page,
  total,
  noun,
  onPage,
}: {
  page: number;
  total: number;
  noun: string;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / CATALOG_PAGE_SIZE));
  if (total <= CATALOG_PAGE_SIZE) return null;
  return (
    <nav className="flex items-center justify-between gap-3 text-sm" aria-label="Paginação">
      <span className="text-muted">
        Página {page} de {pages} · {total} {noun}
      </span>
      <span className="flex gap-2">
        <Button
          variant="secondary"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label="Página anterior"
        >
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        <Button
          variant="secondary"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          aria-label="Próxima página"
        >
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </span>
    </nav>
  );
}

/** Grade de anúncios com foto, preço e estoque; com `supplierId`, só a loja dele. */
function ProductsGrid({ supplierId }: { supplierId: string | null }) {
  const { params, update, page } = useUrlState();
  const search = params.get('q') ?? '';
  const catalog = useCatalogSearch(search, page, supplierId);
  const [searchText, setSearchText] = useState(search);

  useEffect(() => {
    if (searchText === search) return;
    const t = setTimeout(() => update({ q: searchText.trim() || null, pagina: null }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `update` is recreated each render
  }, [searchText, search]);

  return (
    <div className="space-y-6">
      <div className="relative max-w-xl">
        <Search
          className="text-muted pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          aria-hidden
        />
        <input
          type="search"
          aria-label="Buscar produtos"
          placeholder={supplierId ? 'Buscar nesta loja' : 'Buscar por produto, marca ou loja'}
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
            <li
              key={item.listing_id}
              className="border-border bg-surface hover:border-brand/50 overflow-hidden rounded-xl border transition-colors"
            >
              <Link to={`/catalogo/${item.listing_id}`} className="block">
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
                  {item.featured && (
                    <span className="bg-brand text-brand-fg absolute top-2 left-2 rounded-full px-2 py-0.5 text-xs font-medium">
                      Destaque
                    </span>
                  )}
                </div>
                <div className="space-y-1 p-3 pb-1 text-sm">
                  <p className="line-clamp-2 font-medium">{item.name}</p>
                  <p className="font-semibold tabular-nums">
                    {formatBRL(item.wholesale_price_cents)}
                    <span className="text-muted ml-1 text-xs font-normal">atacado</span>
                  </p>
                  {item.suggested_price_cents && (
                    <p className="text-muted text-xs">
                      Venda sugerida {formatBRL(item.suggested_price_cents)}
                    </p>
                  )}
                  <p className={cn('text-xs', item.available > 0 ? 'text-muted' : 'text-danger')}>
                    {item.available > 0
                      ? `${item.available.toLocaleString('pt-BR')} disponíveis`
                      : 'Sem estoque'}
                    {item.variant_count > 0 && ` · ${item.variant_count} variações`}
                  </p>
                </div>
              </Link>
              {!supplierId && (
                <Link
                  to={`/catalogo/loja/${item.supplier_id}`}
                  className="text-brand block truncate px-3 pb-3 text-xs font-medium hover:underline"
                >
                  {item.supplier_name} · ver loja
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}

      <Pager
        page={page}
        total={catalog.data?.total ?? 0}
        noun="produtos"
        onPage={(p) => update({ pagina: String(p) })}
      />
    </div>
  );
}

function SuppliersGrid() {
  const { update, page } = useUrlState();
  const suppliers = useCatalogSuppliers(page);

  if (suppliers.isPending) return <PageLoader />;
  if (suppliers.isError) {
    return <Alert tone="error">{catalogErrorMessage(suppliers.error)}</Alert>;
  }
  if (suppliers.data.items.length === 0) {
    return <p className="text-muted text-sm">Nenhuma loja com produtos publicados ainda.</p>;
  }
  return (
    <div className="space-y-6">
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {suppliers.data.items.map((s) => (
          <li key={s.supplier_id}>
            <Link
              to={`/catalogo/loja/${s.supplier_id}`}
              className="border-border bg-surface hover:border-brand/50 block overflow-hidden rounded-xl border transition-colors"
            >
              <div className="bg-surface-2 relative aspect-video">
                {s.cover_url ? (
                  <img src={s.cover_url} alt="" className="size-full object-cover" loading="lazy" />
                ) : (
                  <Store className="text-muted absolute inset-0 m-auto size-6" aria-hidden />
                )}
              </div>
              <div className="space-y-1 p-3 text-sm">
                <p className="truncate font-medium">{s.supplier_name}</p>
                <p className="text-muted flex items-center gap-1 text-xs">
                  {s.rating_count > 0 ? (
                    <>
                      <Star className="size-3 fill-current text-amber-500" aria-hidden />
                      {s.rating_avg?.toFixed(1)} ({s.rating_count})
                    </>
                  ) : (
                    'Sem avaliações'
                  )}
                  {' · '}
                  {s.listings} {s.listings === 1 ? 'produto' : 'produtos'}
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
      <Pager
        page={page}
        total={suppliers.data.total}
        noun="lojas"
        onPage={(p) => update({ pagina: String(p) })}
      />
    </div>
  );
}

const tabs = [
  { id: 'produtos', label: 'Produtos' },
  { id: 'lojas', label: 'Lojas' },
] as const;

export function CatalogPage() {
  const { params, update } = useUrlState();
  const tab = params.get('aba') === 'lojas' ? 'lojas' : 'produtos';

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Catálogo de fornecedores</h1>
        <p className="text-muted mt-1 text-sm">
          Produtos de todos os fornecedores da TheSigns, com fotos e preços. Abra qualquer loja ou
          anúncio e importe para vender sem estoque próprio.
        </p>
      </div>

      <div role="tablist" aria-label="Catálogo" className="border-border flex gap-1 border-b">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() =>
              update({ aba: t.id === 'produtos' ? null : t.id, pagina: null, q: null })
            }
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              tab === t.id
                ? 'border-brand text-brand'
                : 'text-muted hover:text-fg border-transparent',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'lojas' ? <SuppliersGrid /> : <ProductsGrid supplierId={null} />}
    </div>
  );
}

/** Loja de um fornecedor: todos os anúncios dele (pelo apelido). */
export function SupplierStorePage() {
  const { supplierId = '' } = useParams();
  const valid = /^[0-9a-f-]{36}$/i.test(supplierId);
  const first = useCatalogSearch('', 1, valid ? supplierId : null);
  const name = valid ? first.data?.items[0]?.supplier_name : undefined;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Link
        to="/catalogo?aba=lojas"
        className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Todas as lojas
      </Link>
      <div className="flex items-center gap-3">
        <Store className="text-brand size-6" aria-hidden />
        <h1 className="text-2xl font-semibold tracking-tight">{name ?? 'Loja'}</h1>
      </div>
      {valid ? (
        <ProductsGrid key={supplierId} supplierId={supplierId} />
      ) : (
        <Alert tone="info">Loja não encontrada.</Alert>
      )}
    </div>
  );
}
