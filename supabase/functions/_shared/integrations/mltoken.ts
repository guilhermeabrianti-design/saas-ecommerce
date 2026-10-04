import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { ML_API, parseTokenResponse } from './mercadolivre.ts';
import { StockPushError, type FetchFn } from './stock.ts';
import { storedAccessToken } from './tokenstore.ts';

/**
 * Token de acesso do Mercado Livre de uma conexão (Deno), renovado quando
 * preciso. Usado por `mercadolivre` e `stock-sync`.
 */
export async function mlAccessToken(
  service: SupabaseClient,
  fetchFn: FetchFn,
  connectionId: string,
): Promise<string> {
  const clientId = Deno.env.get('MERCADOLIVRE_CLIENT_ID');
  const clientSecret = Deno.env.get('MERCADOLIVRE_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new StockPushError('Mercado Livre não configurado');

  return storedAccessToken(service, connectionId, 'Mercado Livre', async (refreshToken) => {
    const res = await fetchFn(`${ML_API}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new StockPushError('Mercado Livre: renovação recusada (reconecte a conta)');
    return parseTokenResponse(await res.json());
  });
}
