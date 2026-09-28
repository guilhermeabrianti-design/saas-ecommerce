import { useEffect } from 'react';
import { Link, useParams } from 'react-router';
import { ImageOff } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { isSupabaseConfigured } from '@/lib/supabase';
import { formatBRL } from '@/utils/money';
import { currentAttribution, rememberAttribution, type PublicStore } from '../affiliates';
import { recordVisit, usePublicStore } from '../api';

function Products({ store }: { store: PublicStore }) {
  if (!store.products.length) {
    return <Alert tone="info">Nenhum produto disponível no momento. Volte em breve.</Alert>;
  }
  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {store.products.map((p) => (
        <li key={p.product_id}>
          <Link
            to={`/c/${p.product_id}`}
            className="border-border bg-surface hover:border-brand block overflow-hidden rounded-xl border transition-colors"
          >
            {p.image ? (
              <img
                src={p.image}
                alt=""
                loading="lazy"
                className="bg-surface-2 aspect-square w-full object-cover"
              />
            ) : (
              <div className="bg-surface-2 text-muted flex aspect-square items-center justify-center">
                <ImageOff className="size-8" aria-hidden />
              </div>
            )}
            <div className="space-y-1 p-3">
              <p className="line-clamp-2 text-sm font-medium">{p.name}</p>
              <p className="font-semibold tabular-nums">
                {p.has_variants && (
                  <span className="text-muted text-xs font-normal">a partir de </span>
                )}
                {formatBRL(p.price_cents)}
              </p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function StorePage() {
  const { code = '' } = useParams();
  const store = usePublicStore(code);
  const storeCode = store.data?.store_code;

  useEffect(() => {
    if (!storeCode) return;
    // Quem veio por um link desta loja continua atribuído ao link.
    const previous = currentAttribution();
    if (previous?.link_code && previous.store_code === storeCode) return;
    rememberAttribution({ store_code: storeCode, link_code: null });
    void recordVisit({ store_code: storeCode, link_code: null });
  }, [storeCode]);

  if (!isSupabaseConfigured) return <Alert tone="info">Loja não configurada neste ambiente.</Alert>;
  if (store.isPending) return <PageLoader />;
  if (store.isError)
    return <Alert tone="error">Não foi possível abrir a loja. Tente de novo.</Alert>;
  if (!store.data) {
    return <Alert tone="info">Loja não encontrada. Confira o link com quem o enviou.</Alert>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{store.data.store_name}</h1>
      <Products store={store.data} />
    </div>
  );
}
