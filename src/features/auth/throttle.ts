/**
 * Client-side login backoff. This is a UX courtesy that stops a user from
 * hammering the form; the real control is Supabase Auth's per-IP rate limit
 * (`[auth.rate_limit] sign_in_sign_ups` in supabase/config.toml).
 */
const FREE_ATTEMPTS = 3;
const BASE_LOCK_SECONDS = 15;
const MAX_LOCK_SECONDS = 5 * 60;

/** Seconds the form stays locked after the given number of consecutive failures. */
export function lockSecondsAfter(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  return Math.min(BASE_LOCK_SECONDS * 2 ** (failures - FREE_ATTEMPTS), MAX_LOCK_SECONDS);
}
