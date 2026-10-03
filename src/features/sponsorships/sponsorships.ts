import { z } from 'zod';
import type { PackageInput } from './api';
import { centsToInput, parseBRL } from '@/utils/money';

/** Campanhas patrocinadas (Fase 43). */

export const placements = ['catalog', 'sales_center'] as const;
export type Placement = (typeof placements)[number];

export const placementLabels: Record<Placement, string> = {
  catalog: 'Catálogo',
  sales_center: 'Central de Vendas',
};

export const sponsorshipStatuses = ['pending', 'active', 'cancelled', 'refunded'] as const;
export type SponsorshipStatus = (typeof sponsorshipStatuses)[number];

const packageSchema = z.object({
  id: z.uuid(),
  placement: z.enum(placements),
  name: z.string(),
  duration_days: z.number().int(),
  price_cents: z.number().int(),
});

export const overviewSchema = z.object({
  can_manage: z.boolean(),
  packages: z.array(packageSchema.extend({ sold_out: z.boolean() })),
  listings: z.array(z.object({ id: z.uuid(), name: z.string() })),
  campaigns: z.array(
    z.object({
      id: z.uuid(),
      listing_id: z.uuid(),
      listing_name: z.string(),
      placement: z.enum(placements),
      package_name: z.string(),
      duration_days: z.number().int(),
      price_cents: z.number().int(),
      status: z.enum(sponsorshipStatuses),
      checkout_url: z.string().nullable(),
      starts_at: z.string().nullable(),
      ends_at: z.string().nullable(),
      created_at: z.string(),
      live: z.boolean(),
      views: z.number().int(),
      imports: z.number().int(),
    }),
  ),
});
export type SponsorshipOverview = z.infer<typeof overviewSchema>;
export type Campaign = SponsorshipOverview['campaigns'][number];

export const adminOverviewSchema = z.object({
  packages: z.array(
    packageSchema.extend({
      max_active: z.number().int().nullable(),
      active: z.boolean(),
      position: z.number().int(),
      live: z.number().int(),
    }),
  ),
  revenue_30d_cents: z.coerce.number().int(),
  campaigns: z.array(
    z.object({
      id: z.uuid(),
      supplier_name: z.string(),
      listing_name: z.string(),
      placement: z.enum(placements),
      price_cents: z.number().int(),
      status: z.enum(sponsorshipStatuses),
      starts_at: z.string().nullable(),
      ends_at: z.string().nullable(),
      created_at: z.string(),
      live: z.boolean(),
    }),
  ),
});
export type AdminSponsorshipOverview = z.infer<typeof adminOverviewSchema>;
export type AdminPackage = AdminSponsorshipOverview['packages'][number];

const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

/** Situação de uma campanha para a tela. */
export function campaignState(
  c: Pick<Campaign, 'status' | 'live' | 'starts_at' | 'ends_at'>,
): string {
  if (c.status === 'pending') return 'Aguardando pagamento';
  if (c.status === 'refunded') return 'Estornada';
  if (c.status === 'cancelled') return 'Cancelada';
  if (c.live && c.ends_at) return `No ar até ${day(c.ends_at)}`;
  return c.ends_at ? `Encerrada em ${day(c.ends_at)}` : 'Encerrada';
}

export const durationLabel = (days: number) => `${days} ${days === 1 ? 'dia' : 'dias'}`;

export const sponsorshipAuditLabels: Record<string, string> = {
  'sponsorship.package': 'Pacote de patrocínio salvo',
};

export interface PackageDraft {
  placement: Placement;
  name: string;
  days: string;
  price: string;
  maxActive: string;
  active: boolean;
  position: string;
}

export const toPackageDraft = (p: AdminPackage | null): PackageDraft => ({
  placement: p?.placement ?? 'catalog',
  name: p?.name ?? '',
  days: String(p?.duration_days ?? 7),
  price: p ? centsToInput(p.price_cents) : '',
  maxActive: p?.max_active == null ? '' : String(p.max_active),
  active: p?.active ?? true,
  position: String(p?.position ?? 1),
});

/** Rascunho → envio; nulo quando algum campo é inválido. O banco confere de novo. */
export function packageDraftToInput(d: PackageDraft, id: string | null): PackageInput | null {
  const name = d.name.trim();
  const price = parseBRL(d.price);
  const days = /^\d{1,2}$/.test(d.days.trim()) ? Number(d.days.trim()) : NaN;
  const max =
    d.maxActive.trim() === ''
      ? null
      : /^\d{1,4}$/.test(d.maxActive.trim())
        ? Number(d.maxActive.trim())
        : NaN;
  const position = /^\d{1,4}$/.test(d.position.trim()) ? Number(d.position.trim()) : 0;
  if (
    name.length < 2 ||
    name.length > 60 ||
    price === null ||
    price < 100 ||
    !(days >= 1 && days <= 90) ||
    Number.isNaN(max) ||
    (max !== null && (max < 1 || max > 1000))
  ) {
    return null;
  }
  return {
    id,
    placement: d.placement,
    name,
    duration_days: days,
    price_cents: price,
    max_active: max,
    active: d.active,
    position,
  };
}

const messages: Record<string, string> = {
  'org.forbidden': 'Sem permissão para esta ação.',
  forbidden: 'Só proprietário e administradores compram patrocínio.',
  'sponsorship.invalid': 'Dados inválidos. Revise os campos.',
  invalid_body: 'Dados inválidos. Revise os campos.',
  'sponsorship.not_found': 'Pacote não encontrado.',
  'sponsorship.suppliers_only': 'Patrocínio é só para fornecedores.',
  unavailable: 'Este pacote não está mais à venda.',
  listing_not_visible: 'O anúncio precisa estar publicado e visível no catálogo.',
  already_live: 'Este anúncio já tem um patrocínio no ar neste espaço.',
  sold_out: 'As vagas deste pacote estão esgotadas no momento. Tente mais tarde.',
  not_configured: 'Pagamentos ainda não configurados pela equipe TheSigns.',
  payment_refused: 'O Mercado Pago recusou criar o pagamento. Tente de novo.',
  provider_unavailable: 'O Mercado Pago não respondeu. Tente de novo em instantes.',
  'admin.forbidden': 'Apenas a equipe da plataforma (com verificação em duas etapas).',
};

export function sponsorshipErrorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && messages[message]) return messages[message];
  return 'Não foi possível concluir. Tente de novo.';
}
