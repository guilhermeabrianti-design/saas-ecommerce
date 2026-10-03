import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Flame, ImageOff, Megaphone, Radio, Search, Sparkles } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { Pager } from '@/features/admin/components/Pager';
import { cn } from '@/utils/cn';
import { formatBRL } from '@/utils/money';
import { useSalesCenter, type CenterItem } from '../api';
import { FavoriteButton } from '../components/FavoriteButton';
import {
  CENTER_PAGE_SIZE,
  centerSortHints,
  centerSortLabels,
  centerSorts,
  formatBps,
  salesErrorMessage,
  type CenterSort,
} from '../sales';

const int = (v: number) => v.toLocaleString('pt-BR');

function ItemCard({ item }: { item: CenterItem }) {
  return (
    <Link
      to={`/central/${item.listing_id}`}
      className="border-border bg-surface hover:border-brand/50 block overflow-hidden rounded-xl border transition-colors"
    >
      <div className="bg-surface-2 relative aspect-square">
        {item.cover_url ? (
          <img src={item.cover_url} alt="" className="size-full object-cover" loading="lazy" />
        ) : (
          <ImageOff className="text-muted absolute inset-0 m-auto size-6" aria-hidden />
        )}
        <FavoriteButton
          listingId={item.listing_id}
          favorite={item.is_favorite}
          name={item.name}
          className="absolute top-2 right-2"
        />
        {item.sponsored && (
          <span className="bg-surface/90 text-fg absolute top-2 left-2 rounded-full px-2 py-0.5 text-xs font-medium">
            Patrocinado
          </span>
        )}
        {item.open_campaigns > 0 && (
          <span className="bg-brand text-brand-fg absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium">
            <Radio className="size-3" aria-hidden />
            Em campanha
          </span>
        )}
      </div>
      <div className="space-y-1 p-3 text-sm">
        <p className="line-clamp-2 font-medium">{item.name}</p>
        <p className="text-muted truncate text-xs">{item.supplier_name}</p>
        <p className="tabular-nums">
          <span className="font-semibold">{formatBRL(item.wholesale_price_cents)}</span>
          {item.suggested_price_cents !== null && (
            <span className="text-muted text-xs"> → {formatBRL(item.suggested_price_cents)}</span>
          )}
        </p>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {item.margin_bps !== null && (
            <span className={item.margin_bps > 0 ? 'text-success' : 'text-danger'}>
              Margem {formatBps(item.margin_bps)}
            </span>
          )}
          {item.units_30d > 0 && (
            <span className="text-warning inline-flex items-center gap-1">
              <Flame className="size-3" aria-hidden />
              {int(item.units_30d)} vendidos/30d
            </span>
          )}
          <span className={item.available > 0 ? 'text-muted' : 'text-danger'}>
            {item.available > 0 ? `${int(item.available)} em estoque` : 'Sem estoque'}
          </span>
          <span className="text-muted">
            {item.materials === 0 ? 'Sem materiais' : `${int(item.materials)} materiais`}
          </span>
        </div>
      </div>
    </Link>
  );
}

export function SalesCenterPage() {
  const [params, setParams] = useSearchParams();
  const sortParam = params.get('aba');
  const sort: CenterSort = centerSorts.includes(sortParam as CenterSort)
    ? (sortParam as CenterSort)
    : 'trending';
  const search = params.get('q') ?? '';
  const pageParam = Number(params.get('pagina'));
  const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;
  const center = useSalesCenter(sort, search, page - 1);
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

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Central de Vendas</h1>
          <p className="text-muted mt-1 text-sm">
            O que vender e o material pronto para divulgar: vídeos, imagens, roteiros, títulos e
            hashtags enviados pelos fornecedores.
          </p>
        </div>
        <Link
          to="/central/lives"
          className="border-border bg-surface hover:border-brand/50 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium"
        >
          <Megaphone className="text-brand size-4" aria-hidden />
          Campanhas para lives
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Vitrine" className="flex flex-wrap gap-1">
          {centerSorts.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={sort === s}
              onClick={() => update({ aba: s === 'trending' ? null : s, pagina: null })}
              className={cn(
                'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                sort === s ? 'bg-brand/10 text-brand' : 'text-muted hover:bg-surface-2',
              )}
            >
              {centerSortLabels[s]}
            </button>
          ))}
        </div>
        <div className="relative min-w-60 flex-1">
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
      </div>
      <p className="text-muted -mt-3 text-xs">{centerSortHints[sort]}</p>

      {center.isPending ? (
        <PageLoader />
      ) : center.isError ? (
        <Alert tone="error">{salesErrorMessage(center.error)}</Alert>
      ) : center.data.items.length === 0 ? (
        <div className="border-border rounded-xl border border-dashed px-6 py-16 text-center">
          <Sparkles className="text-muted mx-auto size-8" aria-hidden />
          <p className="mt-3 font-medium">
            {sort === 'favorites' && !search
              ? 'Você ainda não favoritou produtos'
              : 'Nenhum produto encontrado'}
          </p>
          <p className="text-muted mt-1 text-sm">
            {sort === 'favorites' && !search
              ? 'Toque no coração de um produto para guardá-lo aqui.'
              : search
                ? 'Tente outro termo.'
                : 'Quando fornecedores publicarem produtos, eles aparecerão aqui.'}
          </p>
        </div>
      ) : (
        <ul
          className={cn(
            'grid grid-cols-2 gap-4 transition-opacity sm:grid-cols-3 lg:grid-cols-4',
            center.isPlaceholderData && 'opacity-60',
          )}
        >
          {center.data.items.map((item) => (
            <li key={item.listing_id}>
              <ItemCard item={item} />
            </li>
          ))}
        </ul>
      )}

      <Pager
        page={page}
        total={center.data?.total ?? 0}
        pageSize={CENTER_PAGE_SIZE}
        onPage={(p) => update({ pagina: p > 1 ? String(p) : null })}
        noun="produtos"
      />
    </div>
  );
}
