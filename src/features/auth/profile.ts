import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import { useAuth } from './auth-context';

const profileRowSchema = z.object({
  id: z.uuid(),
  full_name: z.string(),
  role: z.enum(['seller', 'supplier', 'admin']),
  /** Só dígitos; nulo em contas anteriores à Fase 18 até o usuário completar. */
  phone: z.string().nullable(),
  document: z.string().nullable(),
  created_at: z.string(),
});

export type Profile = z.infer<typeof profileRowSchema>;

/** Colunas que o usuário pode alterar (grant de update em profiles). */
export interface ProfileUpdate {
  full_name: string;
  phone: string | null;
  document: string | null;
}

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
        .select('id, full_name, role, phone, document, created_at')
        .eq('id', userId!)
        .single();
      if (error) throw error;
      return profileRowSchema.parse(data);
    },
  });
}

export function useUpdateProfile() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (values: ProfileUpdate) => {
      if (!user) throw new Error('Not authenticated');
      const { error } = await getSupabase().from('profiles').update(values).eq('id', user.id);
      if (error) throw error;
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: profileKey(user?.id) }),
        // O checklist do vendedor depende do perfil completo.
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]),
  });
}
