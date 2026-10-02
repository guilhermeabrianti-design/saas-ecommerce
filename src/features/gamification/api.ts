import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSupabase } from '@/lib/supabase';
import { adminConfigSchema, rankingSchema, summarySchema } from './gamification';

export const gamificationKeys = {
  summary: (orgId: string) => ['gamification', orgId, 'summary'] as const,
  ranking: (orgId: string) => ['gamification', orgId, 'ranking'] as const,
  admin: ['gamification-admin'] as const,
};

export function useGamificationSummary(orgId: string) {
  return useQuery({
    queryKey: gamificationKeys.summary(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('gamification_summary', { p_org: orgId });
      if (error) throw error;
      return summarySchema.parse(data);
    },
  });
}

export function useRanking(orgId: string) {
  return useQuery({
    queryKey: gamificationKeys.ranking(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('gamification_ranking', { p_org: orgId });
      if (error) throw error;
      return rankingSchema.parse(data);
    },
  });
}

export function useSetRankingVisibility(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (visible: boolean) => {
      const { error } = await getSupabase().rpc('set_ranking_visibility', {
        p_org: orgId,
        p_visible: visible,
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['gamification', orgId] }),
  });
}

export function useGamificationConfig() {
  return useQuery({
    queryKey: gamificationKeys.admin,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('admin_gamification_config');
      if (error) throw error;
      return adminConfigSchema.parse(data);
    },
  });
}

function useAdminMutation<T>(fn: (input: T) => Promise<void>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: gamificationKeys.admin }),
  });
}

export function useSaveRule() {
  return useAdminMutation(
    async (r: { event: string; points: number; dailyCap: number | null; enabled: boolean }) => {
      const { error } = await getSupabase().rpc('admin_save_gamification_rule', {
        p_event: r.event,
        p_points: r.points,
        p_daily_cap: r.dailyCap,
        p_enabled: r.enabled,
      });
      if (error) throw error;
    },
  );
}

export function useSaveLevels() {
  return useAdminMutation(async (levels: { name: string; min_points: number }[]) => {
    const { error } = await getSupabase().rpc('admin_save_gamification_levels', {
      p_levels: levels,
    });
    if (error) throw error;
  });
}

export function useSaveAchievement() {
  return useAdminMutation(
    async (a: {
      code: string;
      name: string;
      description: string;
      threshold: number;
      active: boolean;
    }) => {
      const { error } = await getSupabase().rpc('admin_save_achievement', {
        p_code: a.code,
        p_name: a.name,
        p_description: a.description,
        p_threshold: a.threshold,
        p_active: a.active,
      });
      if (error) throw error;
    },
  );
}
