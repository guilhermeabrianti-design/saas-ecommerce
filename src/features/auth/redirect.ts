/**
 * Validates a post-login `next` target. Only same-origin absolute paths are
 * allowed, preventing open redirects like `?next=//evil.com` or `?next=https://…`.
 */
export function safeNextPath(next: string | null | undefined, fallback = '/'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
    return fallback;
  }
  try {
    const url = new URL(next, 'http://internal.invalid');
    if (url.origin !== 'http://internal.invalid') return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

/** Absolute URL for Supabase e-mail links (must be in the auth redirect allow-list). */
export function authRedirectUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}
