/**
 * Criptografia das credenciais de API dos marketplaces: AES-256-GCM com a chave
 * CREDENTIALS_ENCRYPTION_KEY (32 bytes em base64), que só existe como segredo
 * das Edge Functions. Formato: `v1.<iv>.<texto cifrado + tag>` (base64).
 *
 * O `aad` (id da conexão) é autenticado junto: um texto cifrado copiado para
 * outra conexão não decifra.
 */

import { timingSafeEqual } from './common.ts';

export const timingSafeEqualText = timingSafeEqual;

const VERSION = 'v1';

const toB64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

const fromB64 = (text: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(text);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function importKey(keyB64: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromB64(keyB64.trim());
  } catch {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY inválida: não é base64');
  }
  if (raw.length !== 32) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY inválida: precisa ter 32 bytes (base64)');
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptCredentials(
  keyB64: string,
  plaintext: string,
  aad: string,
): Promise<string> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(plaintext),
  );
  return `${VERSION}.${toB64(iv)}.${toB64(new Uint8Array(ct))}`;
}

export async function decryptCredentials(
  keyB64: string,
  token: string,
  aad: string,
): Promise<string> {
  const [version, ivB64, ctB64, extra] = token.split('.');
  if (version !== VERSION || !ivB64 || !ctB64 || extra !== undefined) {
    throw new Error('texto cifrado em formato desconhecido');
  }
  const key = await importKey(keyB64);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(ivB64), additionalData: new TextEncoder().encode(aad) },
      key,
      fromB64(ctB64),
    );
    return new TextDecoder().decode(pt);
  } catch {
    // Chave errada, conexão errada ou dado adulterado: não diferenciamos.
    throw new Error('não foi possível decifrar as credenciais');
  }
}

/**
 * Só aceita URL https pública por nome (o vendedor informa o endereço da loja;
 * sem isto o servidor poderia ser induzido a chamar a rede interna).
 * Limite: não resolve DNS, então não impede um domínio público que aponte para IP privado.
 */
export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('endereço da loja inválido');
  }
  const host = url.hostname.toLowerCase();
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    isIp ||
    !host.includes('.') ||
    /(^|\.)(localhost|local|internal|localdomain|lan|home|corp)$/.test(host)
  ) {
    throw new Error('o endereço da loja precisa ser um https:// público, sem porta nem IP');
  }
  return url;
}

/** Domínio da loja Shopify (`minha-loja.myshopify.com`). */
export function assertShopifyDomain(raw: string): string {
  const host = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(host)) {
    throw new Error('domínio Shopify inválido (esperado: loja.myshopify.com)');
  }
  return host;
}
