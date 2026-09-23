import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Download, ImageOff } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { TextField } from '@/components/ui/TextField';
import { useOrganization } from '@/features/organizations/organization-context';
import { orgPermissions } from '@/features/organizations/roles';
import { describeAttributes } from '@/features/products/variants';
import { formatBRL } from '@/utils/money';
import {
  catalogErrorMessage,
  useCatalogDetail,
  useImportListing,
  type CatalogDetail,
} from '../catalog';

function ImportBox({ detail }: { detail: CatalogDetail }) {
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const importListing = useImportListing(orgId);
  const navigate = useNavigate();
  const [prefix, setPrefix] = useState('');

  if (!orgPermissions.editCatalog(active!.role)) {
    return <Alert tone="info">Somente proprietários e administradores importam produtos.</Alert>;
  }

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        importListing.mutate(
          { detail, skuPrefix: prefix },
          {
            onSuccess: ({ productId, imagesFailed }) =>
              void navigate(`/produtos/${productId}`, {
                state: { imported: true, imagesFailed },
              }),
          },
        );
      }}
    >
      {importListing.isError && (
        <Alert tone="error">{catalogErrorMessage(importListing.error)}</Alert>
      )}
      <TextField
        label="Prefixo de SKU (opcional)"
        placeholder="Ex.: FORN-"
        hint={`SKU no seu catálogo: ${prefix.trim()}${detail.sku}`}
        value={prefix}
        onChange={(e) => setPrefix(e.target.value)}
        className="font-mono"
      />
      <p className="text-muted text-sm">
        Cria um produto <strong>rascunho</strong> em {active!.organization.name} com as variações
        ativas e as imagens. Preço inicial:{' '}
        {formatBRL(detail.suggested_price_cents ?? detail.wholesale_price_cents)}; custo:{' '}
        {formatBRL(detail.wholesale_price_cents)}. Você pode editar tudo depois.
      </p>
      <Button type="submit" loading={importListing.isPending}>
        <Download className="size-4" aria-hidden />
        Importar para meus produtos
      </Button>
    </form>
  );
}

export function CatalogListingPage() {
  const { listingId = '' } = useParams();
  const detail = useCatalogDetail(listingId);
  const d = detail.data;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link
        to="/catalogo"
        className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Catálogo
      </Link>

      {detail.isPending ? (
        <PageLoader />
      ) : detail.isError ? (
        <Alert tone="error">{catalogErrorMessage(detail.error)}</Alert>
      ) : !d ? (
        <Alert tone="info">Este produto não está mais disponível no catálogo.</Alert>
      ) : (
        <>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-3">
              <div className="border-border bg-surface-2 relative aspect-square overflow-hidden rounded-xl border">
                {d.image_urls[0] ? (
                  <img src={d.image_urls[0]} alt={d.name} className="size-full object-cover" />
                ) : (
                  <ImageOff className="text-muted absolute inset-0 m-auto size-8" aria-hidden />
                )}
              </div>
              {d.image_urls.length > 1 && (
                <ul className="grid grid-cols-5 gap-2">
                  {d.image_urls.slice(1).map((url, i) =>
                    url ? (
                      <li
                        key={url}
                        className="border-border aspect-square overflow-hidden rounded-lg border"
                      >
                        <img
                          src={url}
                          alt={`${d.name} — imagem ${i + 2}`}
                          className="size-full object-cover"
                          loading="lazy"
                        />
                      </li>
                    ) : null,
                  )}
                </ul>
              )}
            </div>

            <div className="space-y-4">
              <div>
                <p className="text-muted text-sm">{d.supplier_name}</p>
                <h1 className="text-2xl font-semibold tracking-tight">{d.name}</h1>
                {d.brand && <p className="text-muted text-sm">{d.brand}</p>}
              </div>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-muted">Atacado</dt>
                  <dd className="text-lg font-semibold tabular-nums">
                    {formatBRL(d.wholesale_price_cents)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Venda sugerida</dt>
                  <dd className="text-lg font-semibold tabular-nums">
                    {d.suggested_price_cents == null ? '—' : formatBRL(d.suggested_price_cents)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Disponível no fornecedor</dt>
                  <dd className="font-medium">{d.available.toLocaleString('pt-BR')}</dd>
                </div>
                <div>
                  <dt className="text-muted">SKU do fornecedor</dt>
                  <dd className="font-mono text-xs">{d.sku}</dd>
                </div>
                {d.gtin && (
                  <div>
                    <dt className="text-muted">GTIN</dt>
                    <dd className="font-mono text-xs">{d.gtin}</dd>
                  </div>
                )}
                {d.weight_grams && (
                  <div>
                    <dt className="text-muted">Peso</dt>
                    <dd>{d.weight_grams.toLocaleString('pt-BR')} g</dd>
                  </div>
                )}
              </dl>
              <Section title="Importar" description="Traga este produto para o seu catálogo.">
                <ImportBox detail={d} />
              </Section>
            </div>
          </div>

          {d.description && (
            <Section title="Descrição" description="Texto do fornecedor.">
              <p className="text-sm whitespace-pre-line">{d.description}</p>
            </Section>
          )}

          {d.variants.length > 0 && (
            <Section title="Variações" description="Variações ativas e disponibilidade.">
              <ul className="divide-border -my-3 divide-y text-sm">
                {d.variants.map((v) => (
                  <li key={v.sku} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{describeAttributes(v.attributes)}</p>
                      <p className="text-muted font-mono text-xs">{v.sku}</p>
                    </div>
                    <span className={v.available > 0 ? 'text-muted' : 'text-danger'}>
                      {v.available > 0
                        ? `${v.available.toLocaleString('pt-BR')} disp.`
                        : 'Sem estoque'}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
