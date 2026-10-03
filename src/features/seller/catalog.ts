import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { productKeys } from '@/features/products/api';
import { productErrorMessage } from '@/features/products/errors';
import {
  acceptedImageTypes,
  signImagePaths,
  uploadProductImageFile,
  validateImageFile,
} from '@/features/products/images';
import { getSupabase } from '@/lib/supabase';

export const CATALOG_PAGE_SIZE = 24;

const searchRowSchema = z.object({
  listing_id: z.uuid(),
  supplier_id: z.uuid(),
  supplier_name: z.string(),
  name: z.string(),
  brand: z.string().nullable(),
  wholesale_price_cents: z.number().int(),
  suggested_price_cents: z.number().int().nullable(),
  variant_count: z.number().int(),
  available: z.number().int(),
  cover_path: z.string().nullable(),
  featured: z.boolean(),
  sponsored: z.boolean(),
  total_count: z.coerce.number().int(),
});

const detailSchema = z.object({
  listing_id: z.uuid(),
  supplier_name: z.string(),
  sku: z.string(),
  name: z.string(),
  description: z.string(),
  brand: z.string().nullable(),
  gtin: z.string().nullable(),
  weight_grams: z.number().int().nullable(),
  length_mm: z.number().int().nullable(),
  width_mm: z.number().int().nullable(),
  height_mm: z.number().int().nullable(),
  wholesale_price_cents: z.number().int(),
  suggested_price_cents: z.number().int().nullable(),
  category_name: z.string().nullable().optional(),
  available: z.number().int(),
  variants: z.array(
    z.object({
      sku: z.string(),
      attributes: z.record(z.string(), z.string()),
      gtin: z.string().nullable(),
      available: z.number().int(),
    }),
  ),
  image_paths: z.array(z.string()),
});

export type CatalogItem = z.infer<typeof searchRowSchema> & { cover_url: string | null };
export type CatalogDetail = z.infer<typeof detailSchema> & { image_urls: (string | null)[] };

/** Anúncios visíveis; com `supplierId`, só os da loja desse fornecedor. */
export function useCatalogSearch(search: string, page: number, supplierId: string | null = null) {
  return useQuery({
    queryKey: ['catalog', 'search', search, page, supplierId] as const,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('catalog_browse', {
        p_query: search.trim().slice(0, 100),
        p_supplier: supplierId,
        p_limit: CATALOG_PAGE_SIZE,
        p_offset: (page - 1) * CATALOG_PAGE_SIZE,
      });
      if (error) throw error;
      const rows = z.array(searchRowSchema).parse(data);
      const covers = await signImagePaths(
        rows.flatMap((r) => (r.cover_path ? [r.cover_path] : [])),
      );
      let i = 0;
      const items: CatalogItem[] = rows.map((r) => ({
        ...r,
        cover_url: r.cover_path ? (covers[i++] ?? null) : null,
      }));
      return { items, total: rows[0]?.total_count ?? 0 };
    },
  });
}

const supplierRowSchema = z.object({
  supplier_id: z.uuid(),
  supplier_name: z.string(),
  listings: z.number().int(),
  rating_avg: z.coerce.number().nullable(),
  rating_count: z.number().int(),
  cover_path: z.string().nullable(),
  total_count: z.coerce.number().int(),
});
export type CatalogSupplier = z.infer<typeof supplierRowSchema> & { cover_url: string | null };

/** Lojas de fornecedores (apelido, nota, quantidade de anúncios e capa). */
export function useCatalogSuppliers(page: number) {
  return useQuery({
    queryKey: ['catalog', 'suppliers', page] as const,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('catalog_suppliers', {
        p_limit: CATALOG_PAGE_SIZE,
        p_offset: (page - 1) * CATALOG_PAGE_SIZE,
      });
      if (error) throw error;
      const rows = z.array(supplierRowSchema).parse(data);
      const covers = await signImagePaths(
        rows.flatMap((r) => (r.cover_path ? [r.cover_path] : [])),
      );
      let i = 0;
      const items: CatalogSupplier[] = rows.map((r) => ({
        ...r,
        cover_url: r.cover_path ? (covers[i++] ?? null) : null,
      }));
      return { items, total: rows[0]?.total_count ?? 0 };
    },
  });
}

export function useCatalogDetail(listingId: string) {
  return useQuery({
    queryKey: ['catalog', 'detail', listingId] as const,
    queryFn: async (): Promise<CatalogDetail | null> => {
      if (!z.uuid().safeParse(listingId).success) return null;
      const { data, error } = await getSupabase().rpc('get_catalog_listing', {
        p_listing: listingId,
      });
      if (error) {
        if (error.message === 'catalog.listing_not_found') return null;
        throw error;
      }
      const detail = detailSchema.parse(data);
      return { ...detail, image_urls: await signImagePaths(detail.image_paths) };
    },
  });
}

/**
 * Copies the supplier's images into the seller's product folder. Best effort:
 * each failure is counted, never aborts the import.
 */
async function copyImages(orgId: string, productId: string, urls: (string | null)[]) {
  let failed = 0;
  for (const [i, url] of urls.entries()) {
    try {
      if (!url) throw new Error('missing signed url');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const type = acceptedImageTypes.includes(blob.type) ? blob.type : '';
      const file = new File([blob], `catalogo-${i + 1}`, { type });
      if (validateImageFile(file)) throw new Error('invalid image');
      await uploadProductImageFile(orgId, productId, file);
    } catch (e) {
      console.warn('catalog image not copied', e);
      failed++;
    }
  }
  return failed;
}

export interface ImportResult {
  productId: string;
  imagesFailed: number;
}

export function useImportListing(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      detail,
      skuPrefix,
    }: {
      detail: CatalogDetail;
      skuPrefix: string;
    }): Promise<ImportResult> => {
      const { data, error } = await getSupabase().rpc('import_catalog_listing', {
        p_org: orgId,
        p_listing: detail.listing_id,
        p_sku_prefix: skuPrefix.trim(),
      });
      if (error) throw error;
      const productId = z.uuid().parse(data);
      const imagesFailed = await copyImages(orgId, productId, detail.image_urls);
      return { productId, imagesFailed };
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: productKeys.all(orgId) }),
  });
}

const messages: Partial<Record<string, string>> = {
  'catalog.sellers_only': 'O catálogo de fornecedores é exclusivo para empresas vendedoras.',
  'catalog.listing_not_found': 'Este produto não está mais disponível no catálogo.',
  'catalog.already_imported': 'Este produto já foi importado para esta empresa.',
  'catalog.invalid_prefix':
    'Prefixo inválido: até 20 letras, números, ponto, hífen ou sublinhado, e o SKU final com até 60 caracteres.',
};

export function catalogErrorMessage(error: unknown): string {
  const { message } = (error ?? {}) as { message?: unknown };
  if (typeof message === 'string' && messages[message]) return messages[message];
  if (message === 'products.sku_taken') {
    return 'Um SKU deste produto já existe na sua empresa. Use um prefixo, ex.: FORN-';
  }
  return productErrorMessage(error);
}
