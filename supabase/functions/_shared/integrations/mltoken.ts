import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { decryptCredentials, encryptCredentials } from './crypto.ts';
import {
  ML_API,
  getAccessToken,
  parseTokenResponse,
  type MlTokens,
  type StoredMlCredentials,
} from './mercadolivre.ts';
import { StockPushError, type FetchFn } from './stock.ts';

/**
 * Token de acesso do Mercado Livre de uma conexão (Deno): lê e decifra as
 * credenciais, renova quando preciso e grava de volta com a versão
 * esperada. Usado por `mercadolivre` e `stock-sync`.
 */
export async function mlAccessToken(
  service: SupabaseClient,
  fetchFn: FetchFn,
  connectionId: string,
): Promise<string> {
  const key = Deno.env.get('CREDENTIALS_ENCRYPTION_KEY');
  const clientId = Deno.env.get('MERCADOLIVRE_CLIENT_ID');
  const clientSecret = Deno.env.get('MERCADOLIVRE_CLIENT_SECRET');
  if (!key || !clientId || !clientSecret) throw new StockPushError('Mercado Livre não configurado');

  const read = async (): Promise<StoredMlCredentials> => {
    const { data, error } = await service
      .from('integration_credentials')
      .select('ciphertext, config')
      .eq('connection_id', connectionId)
      .maybeSingle();
    if (error || !data)
      throw new StockPushError('Mercado Livre: credenciais não encontradas (reconecte a conta)');
    try {
      return {
        secret: JSON.parse(await decryptCredentials(key, data.ciphertext, connectionId)),
        config: (data.config ?? {}) as StoredMlCredentials['config'],
      };
    } catch {
      throw new StockPushError('Mercado Livre: não foi possível decifrar as credenciais');
    }
  };

  const swap = async (expected: number, next: StoredMlCredentials) => {
    const { data, error } = await service.rpc('swap_connection_credentials', {
      p_connection: connectionId,
      p_expected_version: expected,
      p_ciphertext: await encryptCredentials(key, JSON.stringify(next.secret), connectionId),
      p_config: next.config,
    });
    if (error) throw new StockPushError('Mercado Livre: falha ao gravar o token renovado');
    return data === true;
  };

  const refresh = async (refreshToken: string): Promise<MlTokens> => {
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
  };

  return getAccessToken({ read, swap, refresh });
}
