import { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ImagePlus, ImageOff, Trash2 } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import type { Product } from '../api';
import { productErrorMessage } from '../errors';
import {
  acceptedImageTypes,
  MAX_PRODUCT_IMAGES,
  moveItem,
  useDeleteProductImage,
  useProductImages,
  useReorderProductImages,
  useUploadProductImage,
  validateImageFile,
} from '../images';

export function ImagesSection({ product, canEdit }: { product: Product; canEdit: boolean }) {
  const orgId = product.organization_id;
  const images = useProductImages(orgId, product.id);
  const upload = useUploadProductImage(orgId, product.id);
  const remove = useDeleteProductImage(orgId, product.id);
  const reorder = useReorderProductImages(orgId, product.id);
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const list = images.data ?? [];
  const full = list.length >= MAX_PRODUCT_IMAGES;
  const busy = upload.isPending || remove.isPending || reorder.isPending;
  const error = upload.error ?? remove.error ?? reorder.error;

  async function onFiles(files: FileList | null) {
    setFileError(null);
    const selected = [...(files ?? [])].slice(0, MAX_PRODUCT_IMAGES - list.length);
    for (const file of selected) {
      const problem = validateImageFile(file);
      if (problem) {
        setFileError(`${file.name}: ${problem}`);
        continue;
      }
      // Sequential: the database assigns positions in upload order.
      await upload.mutateAsync(file).catch(() => undefined);
    }
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <Section
      title="Imagens"
      description={`Até ${MAX_PRODUCT_IMAGES} imagens JPEG, PNG ou WebP de até 5 MB. A primeira é a capa.`}
    >
      <div className="space-y-4">
        {fileError && <Alert tone="error">{fileError}</Alert>}
        {error && <Alert tone="error">{productErrorMessage(error)}</Alert>}

        {images.isPending ? (
          <PageLoader />
        ) : images.isError ? (
          <Alert tone="error">{productErrorMessage(images.error)}</Alert>
        ) : list.length === 0 ? (
          <p className="text-muted text-sm">Nenhuma imagem.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {list.map((img, i) => (
              <li key={img.id} className="border-border overflow-hidden rounded-lg border">
                <div className="bg-surface-2 relative aspect-square">
                  {img.url ? (
                    <img
                      src={img.url}
                      alt={`${product.name} — imagem ${i + 1}`}
                      className="size-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <ImageOff className="text-muted absolute inset-0 m-auto size-6" aria-hidden />
                  )}
                  {i === 0 && (
                    <span className="bg-brand text-brand-fg absolute top-2 left-2 rounded px-1.5 py-0.5 text-xs font-medium">
                      Capa
                    </span>
                  )}
                </div>
                {canEdit && (
                  <div className="flex justify-between p-1">
                    <span className="flex">
                      <Button
                        variant="ghost"
                        className="px-2"
                        disabled={busy || i === 0}
                        aria-label={`Mover imagem ${i + 1} para a esquerda`}
                        onClick={() => reorder.mutate(moveItem(list, i, -1).map((x) => x.id))}
                      >
                        <ArrowLeft className="size-4" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        className="px-2"
                        disabled={busy || i === list.length - 1}
                        aria-label={`Mover imagem ${i + 1} para a direita`}
                        onClick={() => reorder.mutate(moveItem(list, i, 1).map((x) => x.id))}
                      >
                        <ArrowRight className="size-4" aria-hidden />
                      </Button>
                    </span>
                    <Button
                      variant="ghost"
                      className="hover:text-danger px-2"
                      disabled={busy}
                      aria-label={`Excluir imagem ${i + 1}`}
                      onClick={() => remove.mutate(img)}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {canEdit && (
          <>
            <input
              ref={inputRef}
              type="file"
              accept={acceptedImageTypes.join(',')}
              multiple
              hidden
              onChange={(e) => void onFiles(e.target.files)}
            />
            <Button
              variant="secondary"
              loading={upload.isPending}
              disabled={full || busy}
              onClick={() => inputRef.current?.click()}
            >
              <ImagePlus className="size-4" aria-hidden />
              {full ? 'Limite atingido' : 'Adicionar imagens'}
            </Button>
          </>
        )}
      </div>
    </Section>
  );
}
