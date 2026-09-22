import { describe, expect, it } from 'vitest';
import { parsePublicEnv } from './env';

describe('parsePublicEnv', () => {
  it('returns null supabase config when not configured', () => {
    const env = parsePublicEnv({ VITE_APP_ENV: 'development' });
    expect(env.supabase).toBeNull();
    expect(env.appEnv).toBe('development');
  });

  it('returns supabase config when url and anon key are present', () => {
    const env = parsePublicEnv({
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'anon',
    });
    expect(env.supabase).toEqual({ url: 'https://example.supabase.co', anonKey: 'anon' });
  });

  it('rejects an invalid url', () => {
    expect(() => parsePublicEnv({ VITE_SUPABASE_URL: 'not-a-url' })).toThrow();
  });

  it('rejects an unknown environment', () => {
    expect(() => parsePublicEnv({ VITE_APP_ENV: 'prod-ish' })).toThrow();
  });

  it('requires supabase in production', () => {
    expect(() => parsePublicEnv({ VITE_APP_ENV: 'production' })).toThrow(/production/);
  });
});
