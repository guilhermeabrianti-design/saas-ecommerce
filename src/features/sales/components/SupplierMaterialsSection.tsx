import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Trash2 } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import type { Product } from '@/features/products/api';
import { useOwnCatalogListing } from '@/features/supplier/catalog-listing';
import { useAddMaterial, useDeleteMaterial, useSupplierMaterials, type Material } from '../api';
import {
  MAX_MATERIALS,
  acceptedTypes,
  isFileKind,
  materialFormSchema,
  materialKindLabels,
  materialKinds,
  salesErrorMessage,
  validateMaterialFile,
  type MaterialFormValues,
} from '../sales';
import { MaterialView } from './MaterialView';

function AddMaterialForm({ orgId, listingId }: { orgId: string; listingId: string }) {
  const add = useAddMaterial(orgId, listingId);
  // Trocar a chave remonta o input e limpa o arquivo escolhido.
  const [fileInputKey, setFileInputKey] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors },
  } = useForm<MaterialFormValues>({
    resolver: zodResolver(materialFormSchema),
    defaultValues: { kind: 'script', title: '', body: '' },
  });
  const kind = useWatch({ control, name: 'kind' });
  const fileKind = isFileKind(kind) ? kind : null;

  const onSubmit = handleSubmit((values) => {
    if (fileKind) {
      const problem = file ? validateMaterialFile(file, fileKind) : 'Escolha o arquivo';
      setFileError(problem);
      if (problem) return;
    }
    add.mutate(
      { ...values, file: fileKind ? file : null },
      {
        onSuccess: () => {
          reset({ kind: values.kind, title: '', body: '' });
          setFile(null);
          setFileInputKey((k) => k + 1);
        },
      },
    );
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {add.isError && <Alert tone="error">{salesErrorMessage(add.error)}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="Tipo" {...register('kind')}>
          {materialKinds.map((k) => (
            <option key={k} value={k}>
              {materialKindLabels[k]}
            </option>
          ))}
        </Select>
        <TextField
          label="Nome"
          placeholder="Ex.: Roteiro de 30 segundos"
          error={errors.title?.message}
          {...register('title')}
        />
      </div>
      {fileKind ? (
        <div className="space-y-1.5">
          <label htmlFor="material-file" className="block text-sm font-medium">
            Arquivo
          </label>
          <input
            id="material-file"
            key={fileInputKey}
            type="file"
            accept={acceptedTypes(fileKind).join(',')}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setFileError(null);
            }}
            className="block text-sm"
          />
          <p className={fileError ? 'text-danger text-xs' : 'text-muted text-xs'}>
            {fileError ??
              (fileKind === 'video'
                ? 'MP4, MOV ou WebM até 100 MB.'
                : 'JPEG, PNG ou WebP até 100 MB.')}
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <label htmlFor="material-body" className="block text-sm font-medium">
            Texto
          </label>
          <textarea
            id="material-body"
            rows={5}
            aria-invalid={errors.body ? true : undefined}
            className="border-border bg-surface focus:border-brand focus:ring-brand/30 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2"
            placeholder={
              kind === 'hashtags'
                ? '#achadinhos #casa #presente'
                : 'Texto pronto para o vendedor copiar'
            }
            {...register('body')}
          />
          {errors.body && <p className="text-danger text-xs">{errors.body.message}</p>}
        </div>
      )}
      <Button type="submit" loading={add.isPending}>
        {add.isPending && fileKind ? 'Enviando…' : 'Adicionar material'}
      </Button>
    </form>
  );
}

function MaterialList({ listingId, canEdit }: { listingId: string; canEdit: boolean }) {
  const materials = useSupplierMaterials(listingId);
  const remove = useDeleteMaterial(listingId);
  if (materials.isPending) return <PageLoader />;
  if (materials.isError) return <Alert tone="error">{salesErrorMessage(materials.error)}</Alert>;
  if (materials.data.length === 0) {
    return <p className="text-muted text-sm">Nenhum material ainda.</p>;
  }
  return (
    <div className="space-y-3">
      {remove.isError && <Alert tone="error">{salesErrorMessage(remove.error)}</Alert>}
      <p className="text-muted text-xs">
        {materials.data.length} de {MAX_MATERIALS} materiais.
      </p>
      {materials.data.map((m: Material) => (
        <MaterialView
          key={m.id}
          material={m}
          actions={
            canEdit && (
              <button
                type="button"
                onClick={() => remove.mutate(m)}
                disabled={remove.isPending}
                className="text-muted hover:text-danger rounded-lg p-1.5"
                aria-label={`Excluir ${m.title}`}
              >
                <Trash2 className="size-4" aria-hidden />
              </button>
            )
          }
        />
      ))}
    </div>
  );
}

/** Materiais de divulgação do anúncio, para os vendedores usarem na Central de Vendas. */
export function SupplierMaterialsSection({
  product,
  canEdit,
}: {
  product: Product;
  canEdit: boolean;
}) {
  const listing = useOwnCatalogListing(product.organization_id, product.id);

  return (
    <Section
      title="Materiais de divulgação"
      description="Vídeos, imagens, roteiros, títulos, hashtags e argumentos que os vendedores baixam e copiam na Central de Vendas."
    >
      {listing.isPending ? (
        <PageLoader />
      ) : listing.isError || !listing.data ? (
        <p className="text-muted text-sm">
          Cadastre o anúncio no catálogo acima para enviar materiais.
        </p>
      ) : (
        <div className="space-y-6">
          <MaterialList listingId={listing.data.id} canEdit={canEdit} />
          {canEdit && (
            <div className="border-border border-t pt-6">
              <AddMaterialForm orgId={product.organization_id} listingId={listing.data.id} />
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
