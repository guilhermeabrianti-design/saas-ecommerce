/**
 * Credenciais de API do marketplace: POST /functions/v1/credentials
 *
 * Corpo (Shopify):     { connection_id, access_token, location_id }
 * Corpo (WooCommerce): { connection_id, consumer_key, consumer_secret }
 *
 * Roda com o JWT de quem chamou: a conexão só é visível para owner/admin da
 * organização (RLS) e `store_connection_credentials` confere de novo. A função
 * valida o endereço da loja (anti-SSRF), CRIPTOGRAFA com
 * CREDENTIALS_ENCRYPTION_KEY (AES-256-GCM, ligada ao id da conexão) e guarda só
 * o texto cifrado. Nada é devolvido nem registrado em log.
 *
 * ATENÇÃO: roda em Deno e não foi executada nos testes do projeto. A
 * criptografia e as validações são testadas em `src/integrations/`.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  assertPublicHttpsUrl,
  assertShopifyDomain,
  encryptCredentials,
} from '../_shared/integrations/crypto.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });

const secretText = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length >= 10 && v.trim().length <= 300 ? v.trim() : null;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const authorization = req.headers.get('Authorization');
  if (!authorization) return json(401, { error: 'unauthorized' });

  let input: Record<string, unknown>;
  try {
    input = await req.json();
  } catch {
    return json(400, { error: 'invalid_body' });
  }
  const connectionId = String(input.connection_id ?? '');
  if (!UUID.test(connectionId)) return json(400, { error: 'invalid_body' });

  const key = Deno.env.get('CREDENTIALS_ENCRYPTION_KEY');
  if (!key) {
    console.error('credentials: CREDENTIALS_ENCRYPTION_KEY não configurada');
    return json(503, { error: 'not_configured' });
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // RLS: só owner/admin da organização enxergam a conexão.
  const { data: conn, error: connError } = await supabase
    .from('integration_connections')
    .select('provider, external_account_id, status')
    .eq('id', connectionId)
    .maybeSingle();
  if (connError) {
    if (/jwt/i.test(connError.message)) return json(401, { error: 'unauthorized' });
    return json(500, { error: 'lookup_failed' });
  }
  if (!conn) return json(404, { error: 'not_found' });
  if (conn.status === 'disconnected') return json(409, { error: 'disconnected' });

  let secretPayload: Record<string, string>;
  let config: Record<string, string> = {};
  try {
    if (conn.provider === 'shopify') {
      assertShopifyDomain(conn.external_account_id);
      const token = secretText(input.access_token);
      const location = String(input.location_id ?? '')
        .trim()
        .replace(/^gid:\/\/shopify\/Location\//, '');
      if (!token) return json(400, { error: 'invalid_credentials' });
      if (!/^\d{1,20}$/.test(location)) return json(400, { error: 'invalid_location' });
      secretPayload = { access_token: token };
      config = { location_id: location };
    } else if (conn.provider === 'woocommerce') {
      assertPublicHttpsUrl(conn.external_account_id);
      const consumerKey = secretText(input.consumer_key);
      const consumerSecret = secretText(input.consumer_secret);
      if (!consumerKey || !consumerSecret) return json(400, { error: 'invalid_credentials' });
      secretPayload = { consumer_key: consumerKey, consumer_secret: consumerSecret };
    } else {
      return json(400, { error: 'provider_unavailable' });
    }
  } catch {
    // Endereço da loja cadastrado na conexão não é seguro/válido.
    return json(400, { error: 'invalid_shop_address' });
  }

  let ciphertext: string;
  try {
    ciphertext = await encryptCredentials(key, JSON.stringify(secretPayload), connectionId);
  } catch {
    console.error('credentials: falha ao criptografar (chave inválida?)');
    return json(503, { error: 'not_configured' });
  }

  const { error } = await supabase.rpc('store_connection_credentials', {
    p_connection: connectionId,
    p_ciphertext: ciphertext,
    p_key_version: 1,
    p_config: config,
  });
  if (error) {
    if (error.message === 'integrations.not_found') return json(404, { error: 'not_found' });
    if (error.message === 'integrations.disconnected') return json(409, { error: 'disconnected' });
    console.error('credentials: falha ao guardar', error.message);
    return json(500, { error: 'store_failed' });
  }
  return json(200, { ok: true });
});
