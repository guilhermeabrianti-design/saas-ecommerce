/**
 * Código puro (sem Deno, sem rede) compartilhado pelas Edge Functions de
 * integração e testado com vitest em `src/integrations/`.
 */

/** Pedido no formato que `public.ingest_marketplace_order` espera. */
export interface NormalizedOrder {
  customer_name: string;
  customer_email?: string;
  customer_phone?: string;
  customer_document?: string;
  ship_postal_code: string;
  ship_street: string;
  ship_number: string;
  ship_complement?: string;
  ship_district: string;
  ship_city: string;
  ship_state: string;
  shipping_cents: number;
  discount_cents: number;
  notes?: string;
  items: { external_item_id: string; quantity: number; unit_price_cents: number }[];
}

export type NormalizeResult =
  { kind: 'order'; externalId: string; order: NormalizedOrder } | { kind: 'skip'; reason: string };

/** Payload sem a estrutura mínima (não adianta tentar de novo). */
export class NormalizeError extends Error {}

/**
 * Valor decimal em texto ("59.90", "1234", "0.5") → centavos, sem float.
 * Mais de duas casas arredonda meio-para-cima.
 */
export function decimalToCents(value: unknown): number {
  const text =
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new NormalizeError(`valor monetário inválido: ${JSON.stringify(value)}`);
  const [, sign, int = '0', frac = ''] = m;
  const padded = (frac + '00').slice(0, 2);
  let cents = Number(int) * 100 + Number(padded);
  if (frac.length > 2 && Number(frac[2]) >= 5) cents += 1;
  return sign === '-' ? -cents : cents;
}

export const onlyDigits = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/\D/g, '') : '';

/** Separa "Rua X, 123" em rua e número; sem número → "S/N". */
export function splitStreet(line: string): { street: string; number: string } {
  const text = line.trim().replace(/\s+/g, ' ');
  const semNumero = /^(.*?)[,\s-]+(?:s\/n|sn)$/i.exec(text);
  if (semNumero?.[1] && semNumero[1].length >= 2) return { street: semNumero[1], number: 'S/N' };
  const m = /^(.*?)[,\s-]+(\d+[A-Za-z]?)$/.exec(text);
  if (m?.[1] && m[1].length >= 2) return { street: m[1], number: m[2] ?? 'S/N' };
  return { street: text, number: 'S/N' };
}

/** Só devolve telefones que o banco aceita (10–13 dígitos); o resto é descartado. */
export function cleanPhone(v: unknown): string | undefined {
  const d = onlyDigits(v);
  return d.length >= 10 && d.length <= 13 ? d : undefined;
}

export function cleanEmail(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const e = v.trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : undefined;
}

/** CPF (11) ou CNPJ (14) só com dígitos; o resto é descartado. */
export function cleanDocument(v: unknown): string | undefined {
  const d = onlyDigits(v);
  return d.length === 11 || d.length === 14 ? d : undefined;
}

export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Remove chaves indefinidas/vazias para o JSON enviado ao banco. */
export function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as T;
}

/** Comparação em tempo constante de duas strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const b64 = (bytes: ArrayBuffer): string => {
  let bin = '';
  for (const byte of new Uint8Array(bytes)) bin += String.fromCharCode(byte);
  return btoa(bin);
};

/** HMAC-SHA256 do corpo bruto, em base64 (Shopify e WooCommerce assinam assim). */
export async function hmacBase64(secret: string, rawBody: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return b64(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)));
}

export async function verifySignature(
  secret: string,
  rawBody: string,
  signature: string | null,
): Promise<boolean> {
  if (!signature) return false;
  return timingSafeEqual(await hmacBase64(secret, rawBody), signature.trim());
}
