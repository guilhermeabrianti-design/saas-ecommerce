import { z } from 'zod';
import { orgKinds } from '@/features/organizations/roles';

export const ticketCategories = [
  'order',
  'payment',
  'product',
  'account',
  'report',
  'other',
] as const;
export type TicketCategory = (typeof ticketCategories)[number];

export const ticketCategoryLabels: Record<TicketCategory, string> = {
  order: 'Pedido ou entrega',
  payment: 'Pagamento, carteira ou saque',
  product: 'Produto ou catálogo',
  account: 'Conta e acesso',
  report: 'Denúncia',
  other: 'Outro assunto',
};

export const ticketStatuses = ['open', 'waiting_user', 'closed'] as const;
export type TicketStatus = (typeof ticketStatuses)[number];

/** Rótulo do estado do ponto de vista de quem abriu ou da equipe. */
export function ticketStatusLabel(status: TicketStatus, staff: boolean): string {
  if (status === 'closed') return 'Encerrado';
  if (status === 'open') return staff ? 'Aguardando a equipe' : 'Com a equipe';
  return staff ? 'Aguardando a pessoa' : 'Respondido — sua vez';
}

export const ticketStatusTone: Record<TicketStatus, string> = {
  open: 'bg-brand/10 text-brand',
  waiting_user: 'bg-warning/10 text-warning',
  closed: 'bg-surface-2 text-muted',
};

export const ticketSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  category: z.enum(ticketCategories),
  subject: z.string(),
  status: z.enum(ticketStatuses),
  organization_id: z.uuid().nullable(),
  order_id: z.uuid().nullable(),
  reported_listing_id: z.uuid().nullable(),
  last_message_at: z.string(),
  created_at: z.string(),
  created_by: z.uuid(),
});

export type Ticket = z.infer<typeof ticketSchema>;

export const messageSchema = z.object({
  id: z.uuid(),
  author_id: z.uuid().nullable(),
  from_staff: z.boolean(),
  body: z.string(),
  created_at: z.string(),
});

export type TicketMessage = z.infer<typeof messageSchema>;

export const adminTicketSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  category: z.enum(ticketCategories),
  subject: z.string(),
  status: z.enum(ticketStatuses),
  requester_name: z.string().nullable(),
  requester_email: z.string().nullable(),
  organization_name: z.string().nullable(),
  reported_name: z.string().nullable(),
  messages: z.number().int(),
  last_from_staff: z.boolean().nullable(),
  last_message_at: z.string(),
  created_at: z.string(),
});

export type AdminTicket = z.infer<typeof adminTicketSchema>;

export const ticketContextSchema = z.object({
  requester_name: z.string().nullable(),
  requester_email: z.string().nullable(),
  organization_name: z.string().nullable(),
  organization_kind: z.enum(orgKinds).nullable(),
  order_number: z.number().int().nullable(),
  reported_name: z.string().nullable(),
  reported_kind: z.enum(orgKinds).nullable(),
  reported_suspended: z.boolean().nullable(),
  reported_listing_name: z.string().nullable(),
});

export type TicketContext = z.infer<typeof ticketContextSchema>;

export const supportOverviewSchema = z.object({
  open: z.number().int(),
  open_reports: z.number().int(),
  waiting_user: z.number().int(),
  closed_7d: z.number().int(),
});

/** Formulário de chamado; `hasListing` = denúncia já com o anúncio anexado. */
export const newTicketSchema = (hasListing: boolean) =>
  z
    .object({
      category: z.enum(ticketCategories),
      subject: z
        .string()
        .trim()
        .min(3, 'Resuma o assunto em pelo menos 3 caracteres')
        .max(120, 'Máximo de 120 caracteres'),
      body: z
        .string()
        .trim()
        .min(10, 'Conte o que aconteceu (pelo menos 10 caracteres)')
        .max(5000, 'Máximo de 5000 caracteres'),
      reported_code: z.string().trim().max(32),
    })
    .refine((v) => v.category !== 'report' || hasListing || v.reported_code !== '', {
      path: ['reported_code'],
      message: 'Informe o código da loja ou do fornecedor denunciado',
    });

export type NewTicketValues = z.infer<ReturnType<typeof newTicketSchema>>;

/** Prefill vindo de links ("Denunciar anúncio", "Pedir ajuda com o pedido"). */
export function ticketPrefill(params: URLSearchParams) {
  const category = params.get('categoria');
  const uuid = (v: string | null) => (v && z.uuid().safeParse(v).success ? v : null);
  return {
    category: (ticketCategories as readonly string[]).includes(category ?? '')
      ? (category as TicketCategory)
      : 'order',
    listingId: uuid(params.get('anuncio')),
    orderId: uuid(params.get('pedido')),
  };
}

const messages: Record<string, string> = {
  'support.invalid': 'Revise o assunto e a mensagem.',
  'support.invalid_order': 'Pedido não encontrado nesta empresa.',
  'support.invalid_reported': 'Loja, fornecedor ou anúncio denunciado não encontrado.',
  'support.report_target_required': 'Informe quem ou o que está sendo denunciado.',
  'support.not_found': 'Chamado não encontrado.',
  'support.forbidden': 'Você não tem permissão para esta ação.',
  'admin.forbidden': 'Apenas a equipe da plataforma (com verificação em duas etapas).',
  rate_limited: 'Muitas mensagens seguidas. Aguarde um pouco e tente de novo.',
};

export function supportErrorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && messages[message]) return messages[message];
  return 'Não foi possível concluir. Tente de novo.';
}

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
