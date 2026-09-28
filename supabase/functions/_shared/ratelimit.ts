/**
 * Limite por IP nas rotas públicas (Fase 26): código puro, testado com
 * vitest em `src/integrations/`. O IP nunca é guardado: só o hash.
 */

export interface RouteLimit {
  bucket: string;
  limit: number;
  windowSeconds: number;
}

/** Limites das rotas públicas do checkout. */
export const CHECKOUT_LIMITS = {
  pay: { bucket: 'checkout.pay', limit: 10, windowSeconds: 600 },
  visit: { bucket: 'checkout.visit', limit: 120, windowSeconds: 3600 },
  read: { bucket: 'checkout.read', limit: 300, windowSeconds: 600 },
} as const satisfies Record<string, RouteLimit>;

/**
 * IP do cliente. Na borda do Supabase o primeiro endereço de
 * `x-forwarded-for` é o do cliente; sem cabeçalho, nulo (sem limite por IP).
 */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip =
    forwarded || headers.get('cf-connecting-ip')?.trim() || headers.get('x-real-ip')?.trim();
  if (!ip || ip.length > 64 || !/^[0-9a-fA-F.:]+$/.test(ip)) return null;
  return ip.toLowerCase();
}

/** Assunto do limite: hash SHA-256 do IP (hex, 64). */
export async function ipSubject(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`thesigns-ip:${ip}`),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
