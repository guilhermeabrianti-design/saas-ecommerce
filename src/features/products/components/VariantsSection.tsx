import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Pencil, Plus, X } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { TextField } from '@/components/ui/TextField';
import { cn } from '@/utils/cn';
import { formatBRL } from '@/utils/money';
import type { Product } from '../api';
import { productErrorMessage } from '../errors';
import {
  describeAttributes,
  emptyVariantForm,
  MAX_VARIANT_ATTRIBUTES,
  toVariantFormValues,
  toVariantPayload,
  useDeleteVariant,
  useSaveVariant,
  useSetVariantActive,
  useVariants,
  variantFormSchema,
  type Variant,
  type VariantFormValues,
} from '../variants';

function VariantForm({
  product,
  variant,
  attributeNames,
  onDone,
}: {
  product: Product;
  variant: Variant | null;
  attributeNames: string[];
  onDone: () => void;
}) {
  const save = useSaveVariant(product.organization_id, product.id);
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<VariantFormValues>({
    resolver: zodResolver(variantFormSchema),
    defaultValues: variant ? toVariantFormValues(variant) : emptyVariantForm(attributeNames),
  });
  const attributes = useFieldArray({ control, name: 'attributes' });

  const onSubmit = handleSubmit((values) => {
    save.mutate(
      { id: variant?.id ?? null, payload: toVariantPayload(values) },
      { onSuccess: onDone },
    );
  });

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="border-border bg-surface-2/50 space-y-4 rounded-lg border p-4"
    >
      <p className="text-sm font-medium">{variant ? 'Editar variação' : 'Nova variação'}</p>
      {save.isError && <Alert tone="error">{productErrorMessage(save.error)}</Alert>}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Atributos</legend>
        {attributes.fields.map((f, i) => (
          <div key={f.id} className="flex items-start gap-2">
            <div className="grid flex-1 gap-2 sm:grid-cols-2">
              <TextField
                label={`Atributo ${i + 1}`}
                placeholder="Ex.: Cor"
                error={errors.attributes?.[i]?.name?.message}
                {...register(`attributes.${i}.name`)}
              />
              <TextField
                label={`Valor ${i + 1}`}
                placeholder="Ex.: Azul"
                error={errors.attributes?.[i]?.value?.message}
                {...register(`attributes.${i}.value`)}
              />
            </div>
            {attributes.fields.length > 1 && (
              <button
                type="button"
                onClick={() => attributes.remove(i)}
                className="text-muted hover:text-fg mt-8 rounded p-1"
                aria-label={`Remover atributo ${i + 1}`}
              >
                <X className="size-4" aria-hidden />
              </button>
            )}
          </div>
        ))}
        {errors.attributes?.message && (
          <p className="text-danger text-xs">{errors.attributes.message}</p>
        )}
        {errors.attributes?.root?.message && (
          <p className="text-danger text-xs">{errors.attributes.root.message}</p>
        )}
        {attributes.fields.length < MAX_VARIANT_ATTRIBUTES && (
          <Button variant="ghost" onClick={() => attributes.append({ name: '', value: '' })}>
            <Plus className="size-4" aria-hidden />
            Atributo
          </Button>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="SKU da variação"
          className="font-mono"
          autoComplete="off"
          error={errors.sku?.message}
          {...register('sku')}
        />
        <TextField
          label="Preço (opcional)"
          inputMode="decimal"
          placeholder={formatBRL(product.price_cents)}
          hint="Vazio = preço do produto"
          error={errors.price?.message}
          {...register('price')}
        />
        <TextField
          label="GTIN / EAN (opcional)"
          inputMode="numeric"
          error={errors.gtin?.message}
          {...register('gtin')}
        />
        <TextField
          label="Peso em g (opcional)"
          inputMode="numeric"
          hint="Vazio = peso do produto"
          error={errors.weightGrams?.message}
          {...register('weightGrams')}
        />
      </div>

      <div className="flex gap-2">
        <Button type="submit" loading={save.isPending}>
          {variant ? 'Salvar variação' : 'Adicionar variação'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

export function VariantsSection({ product, canEdit }: { product: Product; canEdit: boolean }) {
  const orgId = product.organization_id;
  const variants = useVariants(orgId, product.id);
  const setActive = useSetVariantActive(orgId, product.id);
  const remove = useDeleteVariant(orgId, product.id);
  // null = closed, 'new' = adding, otherwise the variant being edited.
  const [editing, setEditing] = useState<'new' | Variant | null>(null);

  // Suggest the attribute names already in use (e.g. Cor, Tamanho) for the next variant.
  const attributeNames = Object.keys(variants.data?.[0]?.attributes ?? {});
  const error = setActive.error ?? remove.error;

  return (
    <Section
      title="Variações"
      description="Cor, tamanho etc. Cada variação é uma unidade vendável com SKU próprio."
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{productErrorMessage(error)}</Alert>}
        {variants.isPending ? (
          <PageLoader />
        ) : variants.isError ? (
          <Alert tone="error">{productErrorMessage(variants.error)}</Alert>
        ) : variants.data.length === 0 ? (
          <p className="text-muted text-sm">
            Sem variações: o próprio produto ({product.sku}) é a unidade vendável.
          </p>
        ) : (
          <ul className="divide-border -my-3 divide-y">
            {variants.data.map((v) => (
              <li
                key={v.id}
                className={cn(
                  'flex flex-wrap items-center gap-3 py-3',
                  !v.is_active && 'opacity-60',
                )}
              >
                <div className="min-w-0 flex-1 text-sm">
                  <p className="truncate font-medium">{describeAttributes(v.attributes)}</p>
                  <p className="text-muted truncate">
                    <span className="font-mono text-xs">{v.sku}</span> ·{' '}
                    {formatBRL(v.price_cents ?? product.price_cents)}
                    {!v.is_active && ' · inativa'}
                  </p>
                </div>
                {canEdit && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="ghost"
                      onClick={() => setEditing(v)}
                      aria-label={`Editar ${describeAttributes(v.attributes)}`}
                    >
                      <Pencil className="size-4" aria-hidden />
                    </Button>
                    <Button
                      variant="secondary"
                      loading={setActive.isPending && setActive.variables?.id === v.id}
                      onClick={() => setActive.mutate({ id: v.id, active: !v.is_active })}
                    >
                      {v.is_active ? 'Desativar' : 'Ativar'}
                    </Button>
                    {product.status === 'draft' && (
                      <ConfirmButton
                        confirmLabel="Excluir"
                        loading={remove.isPending && remove.variables === v.id}
                        onConfirm={() => remove.mutate(v.id)}
                      >
                        Excluir
                      </ConfirmButton>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {canEdit &&
          (editing ? (
            <VariantForm
              key={editing === 'new' ? 'new' : editing.id}
              product={product}
              variant={editing === 'new' ? null : editing}
              attributeNames={attributeNames}
              onDone={() => setEditing(null)}
            />
          ) : (
            <Button variant="secondary" onClick={() => setEditing('new')}>
              <Plus className="size-4" aria-hidden />
              Nova variação
            </Button>
          ))}
      </div>
    </Section>
  );
}
