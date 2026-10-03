import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { useCategories } from '@/features/fees/api';
import { categoryPath, feesErrorMessage, sortCategories } from '@/features/fees/fees';
import { useResubmitListing } from '@/features/moderation/api';
import {
  moderationErrorMessage,
  moderationLabels,
  moderationTones,
} from '@/features/moderation/moderation';
import { FeaturedToggle } from '@/features/plans/components/FeaturedToggle';
import type { Product } from '@/features/products/api';
import { cn } from '@/utils/cn';
import { productErrorMessage } from '@/features/products/errors';
import { formatBRL } from '@/utils/money';
import {
  listingFormSchema,
  toListingFormValues,
  useOwnCatalogListing,
  useSaveCatalogListing,
  type CatalogListing,
  listingKey,
  type ListingFormValues,
} from '../catalog-listing';

/** Situação da análise do anúncio pela equipe, com reenvio quando reprovado. */
function ModerationStatus({
  product,
  listing,
  canEdit,
}: {
  product: Product;
  listing: CatalogListing;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const resubmit = useResubmitListing(() =>
    queryClient.invalidateQueries({ queryKey: listingKey(product.organization_id, product.id) }),
  );
  const status = listing.moderation_status;
  return (
    <div className="border-border space-y-2 rounded-lg border px-3.5 py-3 text-sm">
      <p>
        Análise da equipe TheSigns:{' '}
        <span
          className={cn('rounded-full px-2 py-0.5 text-xs font-medium', moderationTones[status])}
        >
          {moderationLabels[status]}
        </span>
      </p>
      {status === 'pending' && (
        <p className="text-muted">O anúncio aparece para os vendedores depois de aprovado.</p>
      )}
      {listing.moderation_reason && status !== 'approved' && (
        <p className="text-danger">Motivo: {listing.moderation_reason}</p>
      )}
      {status === 'blocked' && (
        <p className="text-muted">Bloqueado pela equipe. Fale com o suporte para revisar.</p>
      )}
      {status === 'rejected' && canEdit && (
        <>
          <p className="text-muted">Corrija o produto e reenvie para uma nova análise.</p>
          <Button
            variant="secondary"
            loading={resubmit.isPending}
            onClick={() => resubmit.mutate(listing.id)}
          >
            Reenviar para análise
          </Button>
        </>
      )}
      {resubmit.isError && (
        <p className="text-danger text-xs">{moderationErrorMessage(resubmit.error)}</p>
      )}
    </div>
  );
}

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

  const visible =
    listing?.is_published &&
    product.status === 'active' &&
    listing.moderation_status === 'approved';

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
      {listing && <ModerationStatus product={product} listing={listing} canEdit={canEdit} />}
      {listing && <FeaturedToggle listingId={listing.id} canEdit={canEdit} />}
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
