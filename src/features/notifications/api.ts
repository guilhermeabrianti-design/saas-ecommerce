import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import { notificationSchema } from './notifications';

export const NOTIFICATIONS_PAGE_SIZE = 30;

export const notificationKeys = {
  all: ['notifications'] as const,
  list: (filter: 'all' | 'unread', limit: number) =>
    ['notifications', 'list', filter, limit] as const,
  unread: ['notifications', 'unread'] as const,
};

const columns =
  'id, organization_id, kind, title, body, link, read_at, created_at, organizations(name)';

export function useNotifications(filter: 'all' | 'unread', limit = NOTIFICATIONS_PAGE_SIZE) {
  return useQuery({
    queryKey: notificationKeys.list(filter, limit),
    queryFn: async () => {
      let query = getSupabase()
        .from('notifications')
        .select(columns)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (filter === 'unread') query = query.is('read_at', null);
      const { data, error } = await query;
      if (error) throw error;
      return z.array(notificationSchema).parse(data);
    },
  });
}

export function useUnreadCount() {
  return useQuery({
    queryKey: notificationKeys.unread,
    queryFn: async () => {
      const { count, error } = await getSupabase()
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .is('read_at', null);
      if (error) throw error;
      return count ?? 0;
    },
    // Rede de segurança caso o Realtime caia.
    refetchInterval: 5 * 60_000,
  });
}

export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await getSupabase().rpc('mark_notifications_read', { p_ids: ids });
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}

export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error } = await getSupabase().rpc('mark_all_notifications_read', { p_org: null });
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}

/**
 * Novas notificações chegam pelo Supabase Realtime (a RLS decide o que o
 * usuário recebe); a lista e o contador são recarregados.
 */
export function useNotificationsRealtime(userId: string | null) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!userId) return;
    const client = getSupabase();
    const channel = client
      .channel(`notifications:${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        () => void queryClient.invalidateQueries({ queryKey: notificationKeys.all }),
      )
      .subscribe();
    return () => {
      void client.removeChannel(channel);
    };
  }, [userId, queryClient]);
}
