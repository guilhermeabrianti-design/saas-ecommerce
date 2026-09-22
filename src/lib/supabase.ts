import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';

/**
 * Browser Supabase client using the public anon key.
 * All data access is protected by RLS on the database — never by this client.
 * `null` when Supabase is not configured (UI must show "Não configurado").
 */
export const supabase: SupabaseClient | null = env.supabase
  ? createClient(env.supabase.url, env.supabase.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    })
  : null;

export const isSupabaseConfigured = supabase !== null;
