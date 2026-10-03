import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { storageFileName } from '@/features/academy/api';
import { providers } from '@/features/integrations/schemas';
import { signImagePaths } from '@/features/products/images';
import { getSupabase } from '@/lib/supabase';
import {
  CENTER_PAGE_SIZE,
  SALES_BUCKET,
  campaignStatuses,
  isFileKind,
  materialKinds,
  toCampaignPayload,
  type CampaignFormValues,
  type CenterSort,
  type MaterialKind,
} from './sales';

const n = z.number().int();
const provider = z.enum(providers).nullable();

export const salesKeys = {
  all: ['sales'] as const,
  center: (sort: CenterSort, search: string, page: number) =>
    ['sales', 'center', sort, search, page] as const,
  listing: (listingId: string) => ['sales', 'listing', listingId] as const,
  supplierMaterials: (listingId: string) => ['sales', 'supplier-materials', listingId] as const,
  campaigns: (orgId: string) => ['sales', 'campaigns', orgId] as const,
  campaign: (orgId: string, id: string) => ['sales', 'campaigns', orgId, id] as const,
  adminCampaigns: ['sales', 'admin-campaigns'] as const,
  adminCampaign: (id: string) => ['sales', 'admin-campaigns', id] as const,
};

// ---------------------------------------------------------------------
// Arquivos (bucket privado): URL assinada para ver e para baixar
// ---------------------------------------------------------------------
export interface SignedFile {
  view: string;
  download: string;
}

async function signMaterialFiles(paths: string[]): Promise<Map<string, SignedFile>> {
  if (paths.length === 0) return new Map();
  const { data, error } = await getSupabase()
    .storage.from(SALES_BUCKET)
    .createSignedUrls(paths, 3600);
  if (error) throw error;
  const result = new Map<string, SignedFile>();
  for (const s of data) {
    if (!s.path || !s.signedUrl) continue;
    const name = s.path.split('/').pop() ?? 'material';
    // Mesmo parâmetro que o SDK usa em `createSignedUrl(..., { download })`.
    const sep = s.signedUrl.includes('?') ? '&' : '?';
    result.set(s.path, {
      view: s.signedUrl,
      download: `${s.signedUrl}${sep}download=${encodeURIComponent(name)}`,
    });
  }
  return result;
}

// ---------------------------------------------------------------------
// Vitrine
// ---------------------------------------------------------------------
const centerRowSchema = z.object({
  listing_id: z.uuid(),
  name: z.string(),
  brand: z.string().nullable(),
  supplier_name: z.string(),
  wholesale_price_cents: n,
  suggested_price_cents: n.nullable(),
  margin_bps: n.nullable(),
  available: n,
  cover_path: z.string().nullable(),
  units_30d: n,
  materials: n,
  is_favorite: z.boolean(),
  open_campaigns: n,
  sponsored: z.boolean(),
  total_count: n,
});

export type CenterItem = Omit<z.infer<typeof centerRowSchema>, 'total_count'> & {
  cover_url: string | null;
};

export function useSalesCenter(sort: CenterSort, search: string, page: number) {
  return useQuery({
    queryKey: salesKeys.center(sort, search, page),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('sales_center', {
        p_sort: sort,
        p_query: search.trim().slice(0, 100) || null,
        p_limit: CENTER_PAGE_SIZE,
        p_offset: page * CENTER_PAGE_SIZE,
      });
      if (error) throw error;
      const rows = z.array(centerRowSchema).parse(data);
      const covers = await signImagePaths(
        rows.flatMap((r) => (r.cover_path ? [r.cover_path] : [])),
      );
      let i = 0;
      const items: CenterItem[] = rows.map(({ total_count: _total, ...r }) => ({
        ...r,
        cover_url: r.cover_path ? (covers[i++] ?? null) : null,
      }));
      return { items, total: rows[0]?.total_count ?? 0 };
    },
  });
}

const materialSchema = z.object({
  id: z.uuid(),
  kind: z.enum(materialKinds),
  title: z.string(),
  body: z.string().nullable(),
  storage_path: z.string().nullable(),
});

const openCampaignSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  provider,
  starts_at: z.string(),
  ends_at: z.string(),
  commission_bps: n.nullable(),
});

const listingDetailSchema = z.object({
  listing_id: z.uuid(),
  name: z.string(),
  brand: z.string().nullable(),
  description: z.string().nullable(),
  supplier_name: z.string(),
  wholesale_price_cents: n,
  suggested_price_cents: n.nullable(),
  units_30d: n,
  is_favorite: z.boolean(),
  materials: z.array(materialSchema),
  campaigns: z.array(openCampaignSchema),
});

export type Material = z.infer<typeof materialSchema> & { file: SignedFile | null };
export type SalesListing = Omit<z.infer<typeof listingDetailSchema>, 'materials'> & {
  materials: Material[];
};

export function useSalesListing(listingId: string) {
  return useQuery({
    queryKey: salesKeys.listing(listingId),
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<SalesListing> => {
      const { data, error } = await getSupabase().rpc('sales_center_listing', {
        p_listing: listingId,
      });
      if (error) throw error;
      const detail = listingDetailSchema.parse(data);
      const files = await signMaterialFiles(
        detail.materials.flatMap((m) => (m.storage_path ? [m.storage_path] : [])),
      );
      return {
        ...detail,
        materials: detail.materials.map((m) => ({
          ...m,
          file: m.storage_path ? (files.get(m.storage_path) ?? null) : null,
        })),
      };
    },
  });
}

export function useToggleFavorite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ listingId, favorite }: { listingId: string; favorite: boolean }) => {
      const table = getSupabase().from('listing_favorites');
      const { error } = favorite
        ? await table.insert({ listing_id: listingId })
        : await table.delete().eq('listing_id', listingId);
      // Já favoritado (clique duplo): o estado desejado já vale.
      if (error && (error as { code?: string }).code !== '23505') throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: salesKeys.all }),
  });
}

// ---------------------------------------------------------------------
// Fornecedor: materiais do próprio anúncio
// ---------------------------------------------------------------------
export function useSupplierMaterials(listingId: string) {
  return useQuery({
    queryKey: salesKeys.supplierMaterials(listingId),
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<Material[]> => {
      const { data, error } = await getSupabase()
        .from('sales_materials')
        .select('id, kind, title, body, storage_path')
        .eq('listing_id', listingId)
        .order('created_at')
        .order('id');
      if (error) throw error;
      const rows = z.array(materialSchema).parse(data);
      const files = await signMaterialFiles(
        rows.flatMap((m) => (m.storage_path ? [m.storage_path] : [])),
      );
      return rows.map((m) => ({
        ...m,
        file: m.storage_path ? (files.get(m.storage_path) ?? null) : null,
      }));
    },
  });
}

export interface NewMaterial {
  kind: MaterialKind;
  title: string;
  body: string;
  file: File | null;
}

export function useAddMaterial(orgId: string, listingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (m: NewMaterial) => {
      const supabase = getSupabase();
      let path: string | null = null;
      if (isFileKind(m.kind)) {
        if (!m.file) throw new Error('file required');
        path = `${listingId}/${crypto.randomUUID()}/${storageFileName(m.file)}`;
        const { error } = await supabase.storage
          .from(SALES_BUCKET)
          .upload(path, m.file, { contentType: m.file.type, upsert: false, cacheControl: '3600' });
        if (error) throw error;
      }
      const { error } = await supabase.from('sales_materials').insert({
        organization_id: orgId,
        listing_id: listingId,
        kind: m.kind,
        title: m.title.trim(),
        body: path ? null : m.body.trim(),
        storage_path: path,
      });
      if (error) {
        // Sem registro, o arquivo enviado não serve para nada.
        if (path) await supabase.storage.from(SALES_BUCKET).remove([path]);
        throw error;
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: salesKeys.supplierMaterials(listingId) }),
  });
}

export function useDeleteMaterial(listingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (m: Material) => {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('sales_materials')
        .delete()
        .eq('id', m.id)
        .select('id');
      if (error) throw error;
      if (!data?.length) throw { message: 'org.forbidden' };
      // Registro primeiro; se a remoção do arquivo falhar ele só fica órfão no bucket privado.
      if (m.storage_path) await supabase.storage.from(SALES_BUCKET).remove([m.storage_path]);
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: salesKeys.supplierMaterials(listingId) }),
  });
}

// ---------------------------------------------------------------------
// Campanhas: vendedor
// ---------------------------------------------------------------------
const sellerCampaignSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  provider,
  starts_at: z.string(),
  ends_at: z.string(),
  commission_bps: n.nullable(),
  listings: n,
  joined: z.boolean(),
});

const campaignListingSchema = z.object({
  listing_id: z.uuid(),
  name: z.string(),
  supplier_name: z.string(),
  wholesale_price_cents: n,
  suggested_price_cents: n.nullable(),
  available: n,
  cover_path: z.string().nullable(),
  materials: n,
});

const sellerCampaignDetailSchema = sellerCampaignSchema
  .omit({ listings: true })
  .extend({ listings: z.array(campaignListingSchema) });

export type SellerCampaign = z.infer<typeof sellerCampaignSchema>;
export type CampaignListing = z.infer<typeof campaignListingSchema> & { cover_url: string | null };
export type SellerCampaignDetail = Omit<z.infer<typeof sellerCampaignDetailSchema>, 'listings'> & {
  listings: CampaignListing[];
};

export function useLiveCampaigns(orgId: string) {
  return useQuery({
    queryKey: salesKeys.campaigns(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('live_campaigns_for_seller', {
        p_org: orgId,
      });
      if (error) throw error;
      return z.array(sellerCampaignSchema).parse(data);
    },
  });
}

export function useLiveCampaign(orgId: string, campaignId: string) {
  return useQuery({
    queryKey: salesKeys.campaign(orgId, campaignId),
    queryFn: async (): Promise<SellerCampaignDetail> => {
      const { data, error } = await getSupabase().rpc('live_campaign_for_seller', {
        p_org: orgId,
        p_campaign: campaignId,
      });
      if (error) throw error;
      const detail = sellerCampaignDetailSchema.parse(data);
      const covers = await signImagePaths(
        detail.listings.flatMap((l) => (l.cover_path ? [l.cover_path] : [])),
      );
      let i = 0;
      return {
        ...detail,
        listings: detail.listings.map((l) => ({
          ...l,
          cover_url: l.cover_path ? (covers[i++] ?? null) : null,
        })),
      };
    },
  });
}

export function useSetParticipation(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ campaignId, join }: { campaignId: string; join: boolean }) => {
      const { error } = await getSupabase().rpc('set_live_campaign_participation', {
        p_org: orgId,
        p_campaign: campaignId,
        p_join: join,
      });
      if (error) throw error;
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: salesKeys.campaigns(orgId) }),
        // A comissão estimada muda para quem participa.
        queryClient.invalidateQueries({ queryKey: ['fees', 'estimate'] }),
      ]),
  });
}

// ---------------------------------------------------------------------
// Campanhas: equipe
// ---------------------------------------------------------------------
const adminCampaignRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  provider,
  starts_at: z.string(),
  ends_at: z.string(),
  commission_bps: n.nullable(),
  status: z.enum(campaignStatuses),
  listings: n,
  participants: n,
});

const adminCampaignSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  provider,
  starts_at: z.string(),
  ends_at: z.string(),
  commission_bps: n.nullable(),
  status: z.enum(campaignStatuses),
  listings: z.array(
    z.object({
      listing_id: z.uuid(),
      product_name: z.string(),
      supplier_name: z.string(),
      is_published: z.boolean(),
    }),
  ),
  participants: z.array(
    z.object({ organization_id: z.uuid(), organization_name: z.string(), joined_at: z.string() }),
  ),
});

export type AdminCampaignRow = z.infer<typeof adminCampaignRowSchema>;
export type AdminCampaign = z.infer<typeof adminCampaignSchema>;

export function useAdminCampaigns() {
  return useQuery({
    queryKey: salesKeys.adminCampaigns,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_live_campaigns');
      if (error) throw error;
      return z.array(adminCampaignRowSchema).parse(data);
    },
  });
}

export function useAdminCampaign(id: string | null) {
  return useQuery({
    queryKey: salesKeys.adminCampaign(id ?? 'nova'),
    enabled: id !== null,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_live_campaign', { p_id: id! });
      if (error) throw error;
      return adminCampaignSchema.parse(data);
    },
  });
}

export function useSaveCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, values }: { id: string | null; values: CampaignFormValues }) => {
      const { data, error } = await getSupabase().rpc('admin_save_live_campaign', {
        p_id: id,
        p_data: toCampaignPayload(values),
      });
      if (error) throw error;
      return z.uuid().parse(data);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: salesKeys.all }),
  });
}
