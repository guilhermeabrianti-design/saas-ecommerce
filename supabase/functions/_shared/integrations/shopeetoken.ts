import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { SHOPEE_HOSTS, requestShopeeTokens, type ShopeeApp } from './shopee.ts';
import { StockPushError, type FetchFn } from './stock.ts';
import { storedAccessToken } from './tokenstore.ts';

/**
 * App da Shopee pelos segredos (Deno): SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY
 * e SHOPEE_ENV ("test" usa o sandbox; padrão produção). Sem eles: null.
 */
export function shopeeAppFromEnv(): ShopeeApp | null {
  const partnerId = Deno.env.get('SHOPEE_PARTNER_ID')?.trim();
  const partnerKey = Deno.env.get('SHOPEE_PARTNER_KEY')?.trim();
  if (!partnerId || !/^\d{1,20}$/.test(partnerId) || !partnerKey) return null;
  const host = Deno.env.get('SHOPEE_ENV') === 'test' ? SHOPEE_HOSTS.test : SHOPEE_HOSTS.production;
  return { host, partnerId, partnerKey };
}

/** Token de acesso da loja, renovado quando preciso. Usado por `shopee` e `stock-sync`. */
export function shopeeAccessToken(
  service: SupabaseClient,
  fetchFn: FetchFn,
  connectionId: string,
  shopId: string,
): Promise<string> {
  const app = shopeeAppFromEnv();
  if (!app) throw new StockPushError('Shopee não configurada');
  return storedAccessToken(service, connectionId, 'Shopee', (refreshToken) =>
    requestShopeeTokens(fetchFn, app, { refreshToken, shopId }),
  );
}
