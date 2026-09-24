import { z } from 'zod';
import { feesErrorMessage } from '@/features/fees/fees';

export const approvalStatuses = ['pending', 'approved', 'rejected'] as const;
export type ApprovalStatus = (typeof approvalStatuses)[number];

export const listingModerations = ['pending', 'approved', 'rejected', 'blocked'] as const;
export type ListingModeration = (typeof listingModerations)[number];

export const approvalLabels: Record<ApprovalStatus, string> = {
  pending: 'Em análise',
  approved: 'Aprovado',
  rejected: 'Reprovado',
};

export const moderationLabels: Record<ListingModeration, string> = {
  pending: 'Em análise',
  approved: 'Aprovado',
  rejected: 'Reprovado',
  blocked: 'Bloqueado',
};

export const moderationTones: Record<ListingModeration, string> = {
  pending: 'bg-brand/10 text-brand',
  approved: 'bg-success/10 text-success',
  rejected: 'bg-danger/10 text-danger',
  blocked: 'bg-danger/10 text-danger',
};

export type ModerationAction = 'approve' | 'reject' | 'block';

/** Ações possíveis a partir de cada estado (espelha `admin_moderate_listing`). */
export function allowedActions(status: ListingModeration): ModerationAction[] {
  switch (status) {
    case 'pending':
      return ['approve', 'reject', 'block'];
    case 'approved':
      return ['reject', 'block'];
    case 'rejected':
      return ['approve', 'block'];
    case 'blocked':
      return ['approve'];
  }
}

export const actionLabels: Record<ModerationAction, string> = {
  approve: 'Aprovar',
  reject: 'Reprovar',
  block: 'Bloquear',
};

export const needsReason = (action: ModerationAction) => action !== 'approve';

/** Motivo aceito pelo banco: 3 a 500 caracteres depois de aparar. */
export const validReason = (text: string) => {
  const t = text.trim();
  return t.length >= 3 && t.length <= 500;
};

const int = z.coerce.number().int();

export const supplierReviewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  created_at: z.string(),
  owner_name: z.string().nullable(),
  owner_email: z.string().nullable(),
  products: int,
  listings: int,
  approval_status: z.enum(approvalStatuses),
  approval_reason: z.string().nullable(),
  approval_reviewed_at: z.string().nullable(),
  suspended_at: z.string().nullable(),
  total_count: int,
});
export type SupplierReview = z.infer<typeof supplierReviewSchema>;

export const moderationListingSchema = z.object({
  listing_id: z.uuid(),
  product_name: z.string(),
  description: z.string(),
  sku: z.string(),
  brand: z.string().nullable(),
  supplier_id: z.uuid(),
  supplier_name: z.string(),
  supplier_approval: z.enum(approvalStatuses),
  category_id: z.uuid().nullable(),
  wholesale_price_cents: int,
  suggested_price_cents: int.nullable(),
  is_published: z.boolean(),
  product_status: z.enum(['draft', 'active', 'archived']),
  moderation_status: z.enum(listingModerations),
  moderation_reason: z.string().nullable(),
  moderated_at: z.string().nullable(),
  image_paths: z.array(z.string()),
  updated_at: z.string(),
  total_count: int,
});
export type ModerationListing = z.infer<typeof moderationListingSchema>;

const messages: Partial<Record<string, string>> = {
  'moderation.invalid': 'Dados inválidos. Revise os campos.',
  'moderation.not_found': 'Item não encontrado ou sem permissão. Atualize a página.',
  'moderation.no_change': 'Nada mudou: o item já está neste estado. Atualize a página.',
  'moderation.reason_required': 'Informe o motivo (3 a 500 caracteres).',
  'moderation.blocked':
    'Este anúncio foi bloqueado pela equipe TheSigns e não pode ser reenviado. Fale com o suporte.',
};

export function moderationErrorMessage(error: unknown): string {
  const { message } = (error ?? {}) as { message?: unknown };
  if (typeof message === 'string' && messages[message]) return messages[message];
  return feesErrorMessage(error);
}

export const moderationAuditLabels: Record<string, string> = {
  'supplier.approved': 'Fornecedor aprovado',
  'supplier.rejected': 'Fornecedor reprovado',
  'listing.approved': 'Anúncio aprovado',
  'listing.rejected': 'Anúncio reprovado',
  'listing.blocked': 'Anúncio bloqueado',
  'listing.edited': 'Anúncio corrigido pela equipe',
};
