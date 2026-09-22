import { z } from 'zod';

/**
 * Public (browser) environment. Only VITE_* variables are allowed here.
 * Server secrets live exclusively in Supabase Edge Function secrets.
 */
const publicEnvSchema = z.object({
  VITE_APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  VITE_SUPABASE_URL: z.string().url().optional().or(z.literal('')),
  VITE_SUPABASE_ANON_KEY: z.string().optional(),
});

export type AppEnvironment = z.infer<typeof publicEnvSchema>['VITE_APP_ENV'];

export interface PublicEnv {
  appEnv: AppEnvironment;
  supabase: { url: string; anonKey: string } | null;
}

export function parsePublicEnv(raw: Record<string, unknown>): PublicEnv {
  const parsed = publicEnvSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid public environment: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  const { VITE_APP_ENV, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY } = parsed.data;

  const supabase =
    VITE_SUPABASE_URL && VITE_SUPABASE_ANON_KEY
      ? { url: VITE_SUPABASE_URL, anonKey: VITE_SUPABASE_ANON_KEY }
      : null;

  if (VITE_APP_ENV === 'production' && !supabase) {
    throw new Error('Supabase must be configured in production.');
  }

  return { appEnv: VITE_APP_ENV, supabase };
}

export const env = parsePublicEnv({
  VITE_APP_ENV: import.meta.env.VITE_APP_ENV,
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
  VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
});
