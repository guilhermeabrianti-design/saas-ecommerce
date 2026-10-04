import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { decryptCredentials, encryptCredentials } from './crypto.ts';
import { getAccessToken, type MlTokens, type StoredMlCredentials } from './mercadolivre.ts';
import { StockPushError } from './stock.ts';

/**
 * Token de acesso OAuth de uma conexão (Deno), para qualquer marketplace:
 * lê e decifra as credenciais, renova com `refresh` quando preciso e grava
 * de volta com a versão esperada (duas renovações simultâneas não se
 * atropelam). Usado por `mercadolivre`, `shopee`, `tiktok` e `stock-sync`.
 */
export async function storedAccessToken(
  service: SupabaseClient,
  connectionId: string,
  label: string,
  refresh: (refreshToken: string, config: StoredMlCredentials['config']) => Promise<MlTokens>,
): Promise<string> {
  const key = Deno.env.get('CREDENTIALS_ENCRYPTION_KEY');
  if (!key) throw new StockPushError(`${label} não configurado`);

  const read = async (): Promise<StoredMlCredentials> => {
    const { data, error } = await service
      .from('integration_credentials')
      .select('ciphertext, config')
      .eq('connection_id', connectionId)
      .maybeSingle();
    if (error || !data)
      throw new StockPushError(`${label}: credenciais não encontradas (reconecte a conta)`);
    try {
      return {
        secret: JSON.parse(await decryptCredentials(key, data.ciphertext, connectionId)),
        config: (data.config ?? {}) as StoredMlCredentials['config'],
      };
    } catch {
      throw new StockPushError(`${label}: não foi possível decifrar as credenciais`);
    }
  };

  const swap = async (expected: number, next: StoredMlCredentials) => {
    const { data, error } = await service.rpc('swap_connection_credentials', {
      p_connection: connectionId,
      p_expected_version: expected,
      p_ciphertext: await encryptCredentials(key, JSON.stringify(next.secret), connectionId),
      p_config: next.config,
    });
    if (error) throw new StockPushError(`${label}: falha ao gravar o token renovado`);
    return data === true;
  };

  let config: StoredMlCredentials['config'] = {};
  return getAccessToken({
    read: async () => {
      const current = await read();
      config = current.config;
      return current;
    },
    swap,
    refresh: (refreshToken) => refresh(refreshToken, config),
  });
}

/** Configuração não secreta guardada com as credenciais (ex.: shop_cipher do TikTok Shop). */
export async function connectionConfig(
  service: SupabaseClient,
  connectionId: string,
): Promise<Record<string, unknown>> {
  const { data } = await service
    .from('integration_credentials')
    .select('config')
    .eq('connection_id', connectionId)
    .maybeSingle();
  return (data?.config ?? {}) as Record<string, unknown>;
}
