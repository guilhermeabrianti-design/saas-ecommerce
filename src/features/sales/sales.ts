import { z } from 'zod';
import { providers, type Provider } from '@/features/integrations/schemas';
import { orgErrorMessage } from '@/features/organizations/errors';

/** Espelha `public.sales_material_kind`. */
export const materialKinds = ['video', 'image', 'script', 'title', 'hashtags', 'argument'] as const;
export type MaterialKind = (typeof materialKinds)[number];

export const materialKindLabels: Record<MaterialKind, string> = {
  video: 'Vídeo',
  image: 'Imagem',
  script: 'Roteiro',
  title: 'Título de anúncio',
  hashtags: 'Hashtags',
  argument: 'Argumento de venda',
};

/** Vídeo e imagem são arquivos; o resto é texto pronto para copiar. */
export const isFileKind = (kind: MaterialKind) => kind === 'video' || kind === 'image';

export const SALES_BUCKET = 'sales-materials';
/** Igual ao `file_size_limit` do bucket (migração). */
export const MAX_MATERIAL_BYTES = 100 * 1024 * 1024;
export const MAX_MATERIALS = 50;

const acceptedByKind: Record<'video' | 'image', string[]> = {
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
  image: ['image/jpeg', 'image/png', 'image/webp'],
};

export function acceptedTypes(kind: 'video' | 'image') {
  return acceptedByKind[kind];
}

/** Pré-checagem para uma mensagem amigável; o bucket valida de novo no servidor. */
export function validateMaterialFile(file: File, kind: 'video' | 'image'): string | null {
  if (!acceptedByKind[kind].includes(file.type)) {
    return kind === 'video' ? 'Use vídeos MP4, MOV ou WebM.' : 'Use imagens JPEG, PNG ou WebP.';
  }
  if (file.size > MAX_MATERIAL_BYTES) return 'O arquivo deve ter no máximo 100 MB.';
  return null;
}

export const materialFormSchema = z
  .object({
    kind: z.enum(materialKinds),
    title: z
      .string()
      .trim()
      .min(2, 'Dê um nome ao material')
      .max(120, 'Use no máximo 120 caracteres'),
    body: z.string().max(5000, 'Use no máximo 5.000 caracteres'),
  })
  .refine((v) => isFileKind(v.kind) || v.body.trim().length > 0, {
    error: 'Escreva o texto do material',
    path: ['body'],
  });
export type MaterialFormValues = z.infer<typeof materialFormSchema>;

// ---------------------------------------------------------------------
// Vitrine
// ---------------------------------------------------------------------
export const centerSorts = ['trending', 'margin', 'new', 'favorites'] as const;
export type CenterSort = (typeof centerSorts)[number];

export const centerSortLabels: Record<CenterSort, string> = {
  trending: 'Em alta',
  margin: 'Maior margem',
  new: 'Novidades',
  favorites: 'Favoritos',
};

export const centerSortHints: Record<CenterSort, string> = {
  trending: 'Mais vendidos pelos lojistas da plataforma nos últimos 30 dias.',
  margin: 'Maior diferença entre o atacado e o preço sugerido pelo fornecedor (antes de taxas).',
  new: 'Anúncios mais recentes do catálogo.',
  favorites: 'Os produtos que você marcou.',
};

export const CENTER_PAGE_SIZE = 24;

export const formatBps = (bps: number) =>
  `${(bps / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;

// ---------------------------------------------------------------------
// Campanhas para lives
// ---------------------------------------------------------------------
export const campaignStatuses = ['draft', 'published', 'cancelled'] as const;
export type CampaignStatus = (typeof campaignStatuses)[number];

export const campaignStatusLabels: Record<CampaignStatus, string> = {
  draft: 'Rascunho',
  published: 'Publicada',
  cancelled: 'Cancelada',
};

export type CampaignPhase = 'upcoming' | 'live' | 'ended';

export function campaignPhase(startsAt: string, endsAt: string, now = Date.now()): CampaignPhase {
  if (now < Date.parse(startsAt)) return 'upcoming';
  if (now < Date.parse(endsAt)) return 'live';
  return 'ended';
}

export const campaignPhaseLabels: Record<CampaignPhase, string> = {
  upcoming: 'Em breve',
  live: 'No ar',
  ended: 'Encerrada',
};

export function formatPeriod(startsAt: string, endsAt: string): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  return `${fmt(startsAt)} até ${fmt(endsAt)}`;
}

/** "2026-09-26T20:00" (input datetime-local, hora local) ↔ ISO. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const localDateTime = z
  .string()
  .refine((v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)), {
    error: 'Data e hora inválidas',
  });

export const campaignFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(3, 'Use ao menos 3 caracteres')
      .max(120, 'Máximo de 120 caracteres'),
    description: z.string().max(2000, 'Máximo de 2.000 caracteres'),
    provider: z.union([z.literal(''), z.enum(providers)]),
    startsAt: localDateTime,
    endsAt: localDateTime,
    /** Em %, vazio = segue as regras de comissão. */
    commission: z
      .string()
      .trim()
      .refine((v) => v === '' || /^\d{1,3}([.,]\d{1,2})?$/.test(v), { error: 'Ex.: 20 ou 22,5' })
      .refine((v) => v === '' || Number(v.replace(',', '.')) <= 100, { error: 'No máximo 100%' }),
    status: z.enum(campaignStatuses),
    listingIds: z.array(z.uuid()).max(200, 'No máximo 200 produtos'),
  })
  .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), {
    error: 'O fim deve ser depois do início',
    path: ['endsAt'],
  })
  .refine((v) => Date.parse(v.endsAt) - Date.parse(v.startsAt) <= 90 * 86_400_000, {
    error: 'Uma campanha dura no máximo 90 dias',
    path: ['endsAt'],
  })
  .refine((v) => v.status !== 'published' || v.listingIds.length > 0, {
    error: 'Inclua ao menos um produto para publicar',
    path: ['listingIds'],
  });
export type CampaignFormValues = z.infer<typeof campaignFormSchema>;

export function toCampaignPayload(v: CampaignFormValues) {
  return {
    name: v.name.trim(),
    description: v.description.trim(),
    provider: (v.provider || null) as Provider | null,
    starts_at: new Date(v.startsAt).toISOString(),
    ends_at: new Date(v.endsAt).toISOString(),
    commission_bps:
      v.commission === '' ? null : Math.round(Number(v.commission.replace(',', '.')) * 100),
    status: v.status,
    listing_ids: v.listingIds,
  };
}

export const salesAuditLabels: Record<string, string> = {
  'live_campaign.created': 'Campanha de live criada',
  'live_campaign.updated': 'Campanha de live alterada',
};

const messages: Partial<Record<string, string>> = {
  'sales.too_many_materials': `Cada produto aceita no máximo ${MAX_MATERIALS} materiais.`,
  'sales.invalid_sort': 'Ordenação inválida.',
  'catalog.sellers_only': 'A Central de Vendas é para contas vendedoras.',
  'catalog.listing_not_found': 'Produto não encontrado ou fora do catálogo.',
  'campaign.invalid': 'Dados da campanha inválidos.',
  'campaign.not_found': 'Campanha não encontrada ou encerrada.',
  'campaign.ended': 'Esta campanha já terminou.',
  'campaign.listing_not_found': 'Um dos produtos escolhidos não existe mais.',
  'campaign.no_listings': 'Inclua ao menos um produto para publicar.',
  'admin.forbidden': 'Acesso restrito à equipe da plataforma.',
};

export function salesErrorMessage(error: unknown): string {
  const { message } = (error ?? {}) as { message?: unknown };
  if (typeof message === 'string') {
    const known = messages[message];
    if (known) return known;
    if (/row-level security/i.test(message)) return 'Você não tem permissão para esta ação.';
  }
  return orgErrorMessage(error);
}
