import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import { productKeys } from './api';

export const PRODUCT_IMAGES_BUCKET = 'product-images';
export const MAX_PRODUCT_IMAGES = 10;
/** Must match the bucket's `file_size_limit` (migration). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const extensionByType: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
export const acceptedImageTypes = Object.keys(extensionByType);

/**
 * Client-side pre-check for a friendly message. The bucket enforces type and
 * size again on the server; this is never the security boundary.
 */
export function validateImageFile(file: File): string | null {
  if (!extensionByType[file.type]) return 'Use imagens JPEG, PNG ou WebP.';
  if (file.size > MAX_IMAGE_BYTES) return 'A imagem deve ter no máximo 5 MB.';
  return null;
}

/** `{org}/{product}/{random}.{ext}` — the layout the storage policies require. */
export function imageStoragePath(orgId: string, productId: string, file: File): string {
  const ext = extensionByType[file.type];
  if (!ext) throw new Error(`unsupported image type ${file.type}`);
  return `${orgId}/${productId}/${crypto.randomUUID().replace(/-/g, '')}.${ext}`;
}

const imageRowSchema = z.object({
  id: z.uuid(),
  storage_path: z.string(),
  position: z.number().int(),
});

export type ProductImage = z.infer<typeof imageRowSchema> & { url: string | null };

const imageKeys = {
  list: (orgId: string, productId: string) =>
    [...productKeys.all(orgId), 'images', productId] as const,
};

/** Image rows in display order, each with a 1-hour signed URL (the bucket is private). */
export function useProductImages(orgId: string, productId: string) {
  return useQuery({
    queryKey: imageKeys.list(orgId, productId),
    // Refresh well before the signed URLs expire.
    staleTime: 30 * 60_000,
    refetchInterval: 45 * 60_000,
    queryFn: async (): Promise<ProductImage[]> => {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('product_images')
        .select('id, storage_path, position')
        .eq('organization_id', orgId)
        .eq('product_id', productId)
        .order('position');
      if (error) throw error;
      const rows = z.array(imageRowSchema).parse(data);
      if (rows.length === 0) return [];

      const { data: signed, error: signError } = await supabase.storage
        .from(PRODUCT_IMAGES_BUCKET)
        .createSignedUrls(
          rows.map((r) => r.storage_path),
          3600,
        );
      if (signError) throw signError;
      const urlByPath = new Map(signed.map((s) => [s.path, s.signedUrl]));
      return rows.map((r) => ({ ...r, url: urlByPath.get(r.storage_path) ?? null }));
    },
  });
}

function useInvalidateImages(orgId: string, productId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: imageKeys.list(orgId, productId) });
}

export function useUploadProductImage(orgId: string, productId: string) {
  const invalidate = useInvalidateImages(orgId, productId);
  return useMutation({
    mutationFn: async (file: File) => {
      const supabase = getSupabase();
      const path = imageStoragePath(orgId, productId, file);
      const { error: uploadError } = await supabase.storage
        .from(PRODUCT_IMAGES_BUCKET)
        .upload(path, file, { contentType: file.type, upsert: false, cacheControl: '3600' });
      if (uploadError) throw uploadError;

      const { error } = await supabase
        .from('product_images')
        .insert({ organization_id: orgId, product_id: productId, storage_path: path });
      if (error) {
        // Don't leave an orphan file behind when the row is refused (limit, permission…).
        await supabase.storage.from(PRODUCT_IMAGES_BUCKET).remove([path]);
        throw error;
      }
    },
    onSettled: invalidate,
  });
}

export function useDeleteProductImage(orgId: string, productId: string) {
  const invalidate = useInvalidateImages(orgId, productId);
  return useMutation({
    mutationFn: async (image: ProductImage) => {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('product_images')
        .delete()
        .eq('organization_id', orgId)
        .eq('id', image.id)
        .select('id');
      if (error) throw error;
      if (!data?.length) throw { message: 'org.forbidden' };
      // Row first: the product never points at a missing file. A failed file
      // removal only leaves an unreferenced object in the private bucket.
      const { error: removeError } = await supabase.storage
        .from(PRODUCT_IMAGES_BUCKET)
        .remove([image.storage_path]);
      if (removeError) console.error('product image file not removed', removeError);
    },
    onSettled: invalidate,
  });
}

export function useReorderProductImages(orgId: string, productId: string) {
  const invalidate = useInvalidateImages(orgId, productId);
  return useMutation({
    mutationFn: async (imageIds: string[]) => {
      const { error } = await getSupabase().rpc('set_product_image_order', {
        p_product: productId,
        p_image_ids: imageIds,
      });
      if (error) throw error;
    },
    onSettled: invalidate,
  });
}

/** New order with the image at `index` moved by `delta` (−1 = earlier). */
export function moveItem<T>(items: readonly T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item as T);
  return next;
}
