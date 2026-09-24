import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { useCategories } from '@/features/fees/api';
import { categoryPath, feesErrorMessage, sortCategories } from '@/features/fees/fees';
import type { Product } from '@/features/products/api';
import { productErrorMessage } from '@/features/products/errors';
import { formatBRL } from '@/utils/money';
import {
  listingFormSchema,
  toListingFormValues,
  useOwnCatalogListing,
  useSaveCatalogListing,
  type CatalogListing,
  type ListingFormValues,
} from '../catalog-listing';

function ListingForm({
  product,
  listing,
  canEdit,
}: {
  product: Product;
  listing: CatalogListing | null;
  canEdit: boolean;
}) {
  const save = useSaveCatalogListing(product.organization_id, product.id);
  const categories = useCategories();
  const allCategories = categories.data ?? [];
  const categoryOptions = sortCategories(allCategories).filter(
    (c) => c.is_active || c.id === listing?.category_id,
  );
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<ListingFormValues>({
    resolver: zodResolver(listingFormSchema),
    defaultValues: toListingFormValues(listing),
  });

  const onSubmit = handleSubmit((values) =>
    save.mutate({ id: listing?.id ?? null, values }, { onSuccess: () => reset(values) }),
  );

  const visible = listing?.is_published && product.status === 'active';

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {save.isError && (
        <Alert tone="error">
          {(save.error as { message?: string }).message?.startsWith('fees.')
            ? feesErrorMessage(save.error)
            : productErrorMessage(save.error)}
        </Alert>
      )}
      {save.isSuccess && !isDirty && <Alert tone="success">Catálogo atualizado.</Alert>}
      {listing?.is_published && product.status !== 'active' && (
        <Alert tone="info">
          Publicado, mas invisível: só produtos com status Ativo aparecem para vendedores.
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Preço de atacado (para o vendedor)"
          inputMode="decimal"
          placeholder="0,00"
          disabled={!canEdit}
          error={errors.wholesale?.message}
          {...register('wholesale')}
        />
        <TextField
          label="Preço de venda sugerido (opcional)"
          inputMode="decimal"
          placeholder={formatBRL(product.price_cents)}
          disabled={!canEdit}
          error={errors.suggested?.message}
          {...register('suggested')}
        />
      </div>
      <Select label="Categoria" disabled={!canEdit} {...register('categoryId')}>
        <option value="">Sem categoria</option>
        {categoryOptions.map((c) => (
          <option key={c.id} value={c.id}>
            {categoryPath(c, allCategories)}
            {c.is_active ? '' : ' (desativada)'}
          </option>
        ))}
      </Select>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          disabled={!canEdit}
          className="accent-brand size-4"
          {...register('isPublished')}
        />
        Publicado no catálogo para vendedores
      </label>
      <p className="text-muted text-sm">
        Vendedores veem nome, descrição, marca, GTIN, medidas, imagens, variações ativas e a
        disponibilidade em estoque — nunca o seu custo.{' '}
        {visible ? 'Status: visível.' : 'Status: não visível.'}
      </p>
      {canEdit && (
        <Button type="submit" loading={save.isPending} disabled={listing !== null && !isDirty}>
          {listing ? 'Salvar catálogo' : 'Adicionar ao catálogo'}
        </Button>
      )}
    </form>
  );
}

/** Supplier organizations only: publish a product to the seller catalog. */
export function CatalogListingSection({
  product,
  canEdit,
}: {
  product: Product;
  canEdit: boolean;
}) {
  const listing = useOwnCatalogListing(product.organization_id, product.id);
  // O select de categoria precisa das opções antes de o formulário registrar o valor.
  const categories = useCategories();

  return (
    <Section
      title="Catálogo para vendedores"
      description="Publique este produto para que lojas vendedoras possam importá-lo."
    >
      {listing.isPending || categories.isPending ? (
        <PageLoader />
      ) : listing.isError ? (
        <Alert tone="error">{productErrorMessage(listing.error)}</Alert>
      ) : categories.isError ? (
        <Alert tone="error">{feesErrorMessage(categories.error)}</Alert>
      ) : (
        <ListingForm product={product} listing={listing.data} canEdit={canEdit} />
      )}
    </Section>
  );
}
