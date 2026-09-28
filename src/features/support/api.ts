import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import {
  adminTicketSchema,
  messageSchema,
  supportOverviewSchema,
  ticketContextSchema,
  ticketSchema,
  type TicketCategory,
} from './support';

export const SUPPORT_PAGE_SIZE = 50;

export const supportKeys = {
  all: ['support'] as const,
  mine: ['support', 'mine'] as const,
  ticket: (id: string) => ['support', 'ticket', id] as const,
  admin: ['support', 'admin'] as const,
  adminList: (status: string, category: string, page: number) =>
    ['support', 'admin', 'list', status, category, page] as const,
  adminOverview: ['support', 'admin', 'overview'] as const,
  context: (id: string) => ['support', 'admin', 'context', id] as const,
};

const ticketColumns =
  'id, number, category, subject, status, organization_id, order_id, reported_listing_id, last_message_at, created_at, created_by';

export function useMyTickets(userId: string) {
  return useQuery({
    queryKey: supportKeys.mine,
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('support_tickets')
        .select(ticketColumns)
        .eq('created_by', userId)
        .order('last_message_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return z.array(ticketSchema).parse(data);
    },
  });
}

/** Chamado e mensagens (a RLS decide quem vê). Nulo = não encontrado. */
export function useTicket(id: string) {
  return useQuery({
    queryKey: supportKeys.ticket(id),
    queryFn: async () => {
      if (!z.uuid().safeParse(id).success) return null;
      const client = getSupabase();
      const [ticket, messages] = await Promise.all([
        client.from('support_tickets').select(ticketColumns).eq('id', id).maybeSingle(),
        client
          .from('support_messages')
          .select('id, author_id, from_staff, body, created_at')
          .eq('ticket_id', id)
          .order('created_at'),
      ]);
      if (ticket.error) throw ticket.error;
      if (messages.error) throw messages.error;
      if (!ticket.data) return null;
      return {
        ticket: ticketSchema.parse(ticket.data),
        messages: z.array(messageSchema).parse(messages.data),
      };
    },
    // A conversa aberta acompanha respostas sem recarregar.
    refetchInterval: 30_000,
  });
}

export interface NewTicketInput {
  orgId: string | null;
  category: TicketCategory;
  subject: string;
  body: string;
  orderId: string | null;
  reportedCode: string | null;
  listingId: string | null;
}

export function useCreateTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: NewTicketInput) => {
      const { data, error } = await getSupabase().rpc('create_support_ticket', {
        p_org: input.orgId,
        p_category: input.category,
        p_subject: input.subject.trim(),
        p_body: input.body.trim(),
        p_order: input.orderId,
        p_reported_code: input.reportedCode?.trim() || null,
        p_listing: input.listingId,
      });
      if (error) throw error;
      return z.uuid().parse(data);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: supportKeys.all }),
  });
}

export function useReplyTicket(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: string) => {
      const { error } = await getSupabase().rpc('reply_support_ticket', {
        p_ticket: id,
        p_body: body.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: supportKeys.all }),
  });
}

export function useCloseTicket(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error } = await getSupabase().rpc('close_support_ticket', { p_ticket: id });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: supportKeys.all }),
  });
}

// ---------------------------------------------------------------------
// Equipe
// ---------------------------------------------------------------------

export function useSupportOverview() {
  return useQuery({
    queryKey: supportKeys.adminOverview,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_support_overview');
      if (error) throw error;
      return supportOverviewSchema.parse(data);
    },
  });
}

export function useAdminTickets(status: string, category: TicketCategory | '', page: number) {
  return useQuery({
    queryKey: supportKeys.adminList(status, category, page),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_support_tickets', {
        p_status: status,
        p_category: category || null,
        p_limit: SUPPORT_PAGE_SIZE,
        p_offset: (page - 1) * SUPPORT_PAGE_SIZE,
      });
      if (error) throw error;
      return z.array(adminTicketSchema).parse(data);
    },
  });
}

export function useTicketContext(id: string) {
  return useQuery({
    queryKey: supportKeys.context(id),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_support_ticket_context', {
        p_ticket: id,
      });
      if (error) throw error;
      return data ? ticketContextSchema.parse(data) : null;
    },
  });
}
