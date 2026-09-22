import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import { useAuth } from './auth-context';

const profileRowSchema = z.object({
  id: z.uuid(),
  full_name: z.string(),
  role: z.enum(['seller', 'supplier', 'admin']),
  created_at: z.string(),
});

export type Profile = z.infer<typeof profileRowSchema>;

const profileKey = (userId: string | undefined) => ['profile', userId] as const;

export function useProfile() {
  const { user } = useAuth();
  const userId = user?.id;
  return useQuery({
    queryKey: profileKey(userId),
    enabled: userId !== undefined,
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('profiles')
        .select('id, full_name, role, created_at')
        .eq('id', userId!)
        .single();
      if (error) throw error;
      return profileRowSchema.parse(data);
    },
  });
}

export function useUpdateFullName() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (fullName: string) => {
      if (!user) throw new Error('Not authenticated');
      const { error } = await getSupabase()
        .from('profiles')
        .update({ full_name: fullName })
        .eq('id', user.id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: profileKey(user?.id) }),
  });
}
