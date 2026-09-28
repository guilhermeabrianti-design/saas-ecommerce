/**
 * Afiliados (Fase 23): código puro usado pela Edge Function `checkout` e
 * testado com vitest em `src/integrations/`.
 *
 *  * Códigos públicos (loja e links): 4–32 caracteres, minúsculas, dígitos
 *    e hífen no meio. O banco valida de novo.
 *  * O navegador manda um id aleatório de visitante; só o hash SHA-256 dele
 *    vai para o banco.
 *  * Origem inválida nunca impede a compra: é descartada.
 */

const CODE = /^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Código normalizado (minúsculo, sem espaços) ou nulo quando inválido. */
export function parsePublicCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.trim().toLowerCase();
  return CODE.test(code) && !code.includes('--') ? code : null;
}

export interface Attribution {
  store_code: string | null;
  link_code: string | null;
}

/** Origem declarada pelo navegador no pagamento; nula quando não há nada aproveitável. */
export function parseAttribution(input: unknown): Attribution | null {
  if (!input || typeof input !== 'object') return null;
  const a = input as Record<string, unknown>;
  const attribution = {
    store_code: parsePublicCode(a.store_code),
    link_code: parsePublicCode(a.link_code),
  };
  return attribution.store_code || attribution.link_code ? attribution : null;
}

/** Hash do id de visitante (uuid aleatório do navegador). Nulo quando inválido. */
export async function visitorHash(visitorId: unknown): Promise<string | null> {
  if (typeof visitorId !== 'string' || !UUID.test(visitorId)) return null;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`thesigns-visitor:${visitorId.toLowerCase()}`),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface VisitInput {
  store_code: string | null;
  link_code: string | null;
  visitor: string;
}

/** Corpo de POST /visit: um dos códigos e o id do visitante. */
export async function parseVisit(input: unknown): Promise<VisitInput | null> {
  if (!input || typeof input !== 'object') return null;
  const b = input as Record<string, unknown>;
  const attribution = parseAttribution(b);
  const visitor = await visitorHash(b.visitor_id);
  if (!attribution || !visitor) return null;
  return { ...attribution, visitor };
}
