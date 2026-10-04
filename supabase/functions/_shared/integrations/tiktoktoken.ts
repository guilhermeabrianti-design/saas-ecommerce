import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { StockPushError, type FetchFn } from './stock.ts';
import { requestTikTokTokens, tiktokClient, type TikTokApp, type TikTokClient } from './tiktok.ts';
import { connectionConfig, storedAccessToken } from './tokenstore.ts';

/**
 * App da TikTok Shop pelos segredos (Deno): TIKTOK_APP_KEY, TIKTOK_APP_SECRET
 * e TIKTOK_SERVICE_ID (link de autorização). Sem eles: null.
 */
export function tiktokAppFromEnv(): TikTokApp | null {
  const appKey = Deno.env.get('TIKTOK_APP_KEY')?.trim();
  const appSecret = Deno.env.get('TIKTOK_APP_SECRET')?.trim();
  const serviceId = Deno.env.get('TIKTOK_SERVICE_ID')?.trim();
  if (!appKey || !appSecret || !serviceId || !/^[A-Za-z0-9_-]{1,80}$/.test(serviceId)) return null;
  return { appKey, appSecret, serviceId };
}

/** Token de acesso da loja, renovado quando preciso. Usado por `tiktok` e `stock-sync`. */
export function tiktokAccessToken(
  service: SupabaseClient,
  fetchFn: FetchFn,
  connectionId: string,
): Promise<string> {
  const app = tiktokAppFromEnv();
  if (!app) throw new StockPushError('TikTok Shop não configurada');
  return storedAccessToken(service, connectionId, 'TikTok Shop', (refreshToken) =>
    requestTikTokTokens(fetchFn, app, { refreshToken }),
  );
}

/** Sessão da loja da conexão: token renovado + shop_cipher guardado na conexão. */
export async function tiktokShopSession(
  service: SupabaseClient,
  fetchFn: FetchFn,
  connectionId: string,
): Promise<{ app: TikTokApp; accessToken: string; api: TikTokClient }> {
  const app = tiktokAppFromEnv();
  if (!app) throw new StockPushError('TikTok Shop não configurada');
  const accessToken = await tiktokAccessToken(service, fetchFn, connectionId);
  const cipher = String((await connectionConfig(service, connectionId)).shop_cipher ?? '');
  if (!cipher) throw new StockPushError('TikTok Shop: loja sem identificador (reconecte a loja)');
  return { app, accessToken, api: tiktokClient(fetchFn, app, { accessToken, shopCipher: cipher }) };
}

/** Cliente da loja da conexão. */
export async function tiktokShopClient(
  service: SupabaseClient,
  fetchFn: FetchFn,
  connectionId: string,
): Promise<TikTokClient> {
  return (await tiktokShopSession(service, fetchFn, connectionId)).api;
}
