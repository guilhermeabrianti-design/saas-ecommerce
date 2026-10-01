import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useForm, useWatch, type Control } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { useOrganization } from '@/features/organizations/organization-context';
import { GenerateDescriptionButton } from '@/features/ai/components/GenerateDescriptionButton';
import { ChannelsSection } from '@/features/channels/components/ChannelsSection';
import { ProductCheckoutSection } from '@/features/checkout/components/ProductCheckoutSection';
import { orgPermissions } from '@/features/organizations/roles';
import { CatalogListingSection } from '@/features/supplier/components/CatalogListingSection';
import { SupplierMaterialsSection } from '@/features/sales/components/SupplierMaterialsSection';
import { formatBRL, parseBRL } from '@/utils/money';
import {
  useCreateProduct,
  useDeleteProduct,
  useProduct,
  useUpdateProduct,
  type Product,
} from '../api';
import { ImagesSection } from '../components/ImagesSection';
import { VariantsSection } from '../components/VariantsSection';
import { productErrorMessage } from '../errors';
import {
  emptyProductForm,
  productFormSchema,
  productStatuses,
  productStatusLabels,
  toProductFormValues,
  toProductPayload,
  type ProductFormValues,
} from '../schemas';

function MarginHint({ control }: { control: Control<ProductFormValues> }) {
  const [price, cost] = useWatch({ control, name: ['price', 'cost'] });
  const p = parseBRL(price);
  const c = parseBRL(cost);
  if (p === null || c === null || p === 0) return null;
  const margin = ((p - c) / p) * 100;
  return (
    <p className={margin < 0 ? 'text-danger text-sm' : 'text-muted text-sm'}>
      Margem bruta: {formatBRL(p - c)} (
      {margin.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}
      %)
    </p>
  );
}

function ProductForm({ product }: { product: Product | null }) {
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const canEdit = orgPermissions.editCatalog(active!.role);
  const navigate = useNavigate();

  const create = useCreateProduct(orgId);
  const update = useUpdateProduct(orgId, product?.id ?? '');
  const remove = useDeleteProduct(orgId);
  const save = product ? update : create;

  const {
    register,
    handleSubmit,
    control,
    reset,
    setValue,
    formState: { errors, isDirty },
  } = useForm<ProductFormValues>({
    resolver: zodResolver(productFormSchema),
    defaultValues: product ? toProductFormValues(product) : emptyProductForm,
  });

  const onSubmit = handleSubmit((values) => {
    const payload = toProductPayload(values);
    if (product) {
      update.mutate(payload, { onSuccess: () => reset(values) });
    } else {
      create.mutate(payload, {
        onSuccess: (id) => void navigate(`/produtos/${id}`, { replace: true }),
      });
    }
  });

  const field = (name: keyof ProductFormValues) => ({
    ...register(name),
    error: errors[name]?.message,
    disabled: !canEdit,
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      {!canEdit && (
        <Alert tone="info">Somente proprietários e administradores editam produtos.</Alert>
      )}
      {save.isError && <Alert tone="error">{productErrorMessage(save.error)}</Alert>}
      {product && update.isSuccess && !isDirty && <Alert tone="success">Produto salvo.</Alert>}

      <Section title="Informações" description="Como o produto é identificado no seu catálogo.">
        <div className="space-y-4">
          <TextField label="Nome" autoComplete="off" {...field('name')} />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="SKU"
              autoComplete="off"
              hint="Código interno único, ex.: CAM-BRANCA-M"
              className="font-mono"
              {...field('sku')}
            />
            <TextField label="Marca (opcional)" autoComplete="off" {...field('brand')} />
          </div>
          <TextField
            label="GTIN / EAN (opcional)"
            inputMode="numeric"
            autoComplete="off"
            hint="Código de barras com 8, 12, 13 ou 14 dígitos"
            {...field('gtin')}
          />
          <div className="space-y-1.5">
            <label htmlFor="product-description" className="block text-sm font-medium">
              Descrição (opcional)
            </label>
            <textarea
              id="product-description"
              rows={5}
              disabled={!canEdit}
              aria-invalid={errors.description ? true : undefined}
              className="border-border bg-surface focus:border-brand focus:ring-brand/30 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 disabled:opacity-60"
              {...register('description')}
            />
            {errors.description && (
              <p className="text-danger text-xs">{errors.description.message}</p>
            )}
            {product && canEdit && (
              <GenerateDescriptionButton
                orgId={orgId}
                productId={product.id}
                disabled={isDirty}
                disabledReason="Salve as alterações antes: a IA usa os dados salvos do produto."
                onGenerated={(text) =>
                  setValue('description', text, { shouldDirty: true, shouldValidate: true })
                }
              />
            )}
          </div>
        </div>
      </Section>

      <Section
        title="Preço"
        description="Valores em reais. O custo é visível só para a sua organização."
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Preço de venda"
              inputMode="decimal"
              placeholder="0,00"
              {...field('price')}
            />
            <TextField
              label="Custo (opcional)"
              inputMode="decimal"
              placeholder="0,00"
              {...field('cost')}
            />
          </div>
          <MarginHint control={control} />
        </div>
      </Section>

      <Section title="Peso e dimensões" description="Usados no cálculo de frete dos marketplaces.">
        <div className="grid gap-4 sm:grid-cols-4">
          <TextField label="Peso (g)" inputMode="numeric" {...field('weightGrams')} />
          <TextField label="Compr. (mm)" inputMode="numeric" {...field('lengthMm')} />
          <TextField label="Largura (mm)" inputMode="numeric" {...field('widthMm')} />
          <TextField label="Altura (mm)" inputMode="numeric" {...field('heightMm')} />
        </div>
      </Section>

      <Section
        title="Status"
        description="Rascunhos podem ser excluídos; produtos ativos ou arquivados, não."
      >
        <Select label="Status" disabled={!canEdit} {...register('status')}>
          {productStatuses.map((s) => (
            <option key={s} value={s}>
              {productStatusLabels[s]}
            </option>
          ))}
        </Select>
      </Section>

      {canEdit && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button type="submit" loading={save.isPending} disabled={product !== null && !isDirty}>
            {product ? 'Salvar alterações' : 'Cadastrar produto'}
          </Button>
          {product?.status === 'draft' && (
            <div className="space-y-2">
              {remove.isError && <Alert tone="error">{productErrorMessage(remove.error)}</Alert>}
              <ConfirmButton
                confirmLabel="Excluir rascunho"
                loading={remove.isPending}
                onConfirm={() =>
                  remove.mutate(product.id, {
                    onSuccess: () => void navigate('/produtos', { replace: true }),
                  })
                }
              >
                Excluir
              </ConfirmButton>
            </div>
          )}
        </div>
      )}
    </form>
  );
}

function PageHeader({ title }: { title: string }) {
  return (
    <div>
      <Link
        to="/produtos"
        className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Produtos
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h1>
    </div>
  );
}

export function NewProductPage() {
  const { active } = useOrganization();
  if (!orgPermissions.editCatalog(active!.role)) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <PageHeader title="Novo produto" />
        <Alert tone="info">Somente proprietários e administradores cadastram produtos.</Alert>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Novo produto" />
      <ProductForm product={null} />
    </div>
  );
}

/** Set by the catalog import (router state) to confirm what happened. */
interface ImportedState {
  imported?: boolean;
  imagesFailed?: number;
}

export function EditProductPage() {
  const { productId = '' } = useParams();
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const product = useProduct(orgId, productId);
  const imported = (useLocation().state ?? {}) as ImportedState;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={product.data?.name ?? 'Produto'} />
      {imported.imported && (
        <Alert tone={imported.imagesFailed ? 'error' : 'success'}>
          Produto importado como rascunho. Revise preço e dados e ative quando estiver pronto.
          {imported.imagesFailed
            ? ` ${imported.imagesFailed} imagem(ns) não puderam ser copiadas; envie-as manualmente.`
            : ''}
        </Alert>
      )}
      {product.data?.source_listing_id && (
        <p className="text-muted text-sm">
          Importado do{' '}
          <Link
            to={`/catalogo/${product.data.source_listing_id}`}
            className="text-brand hover:underline"
          >
            catálogo de fornecedores
          </Link>
          .
        </p>
      )}
      {product.isPending ? (
        <PageLoader />
      ) : product.isError ? (
        <Alert tone="error">{productErrorMessage(product.error)}</Alert>
      ) : product.data === null ? (
        <Alert tone="info">Produto não encontrado nesta organização.</Alert>
      ) : (
        // Keyed so switching products (or organizations) resets all local state.
        <div key={`${orgId}:${product.data.id}`} className="space-y-6">
          <ProductForm product={product.data} />
          {active!.organization.kind === 'seller' && (
            <ChannelsSection
              product={product.data}
              canEdit={orgPermissions.editCatalog(active!.role)}
            />
          )}
          <VariantsSection
            product={product.data}
            canEdit={orgPermissions.editCatalog(active!.role)}
          />
          <ImagesSection
            product={product.data}
            canEdit={orgPermissions.editCatalog(active!.role)}
          />
          {active!.organization.kind === 'seller' && product.data.source_listing_id && (
            <ProductCheckoutSection
              productId={product.data.id}
              canEdit={orgPermissions.editCatalog(active!.role)}
            />
          )}
          {active!.organization.kind === 'supplier' && (
            <>
              <CatalogListingSection
                product={product.data}
                canEdit={orgPermissions.editCatalog(active!.role)}
              />
              <SupplierMaterialsSection
                product={product.data}
                canEdit={orgPermissions.editCatalog(active!.role)}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
