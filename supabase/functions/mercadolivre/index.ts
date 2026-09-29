/**
 * Mercado Livre (Fase 31): /functions/v1/mercadolivre/...
 *
 *   POST /connect        (JWT) começa o OAuth: devolve a URL de autorização
 *   GET  /callback       volta do Mercado Livre: troca o código, cria a conexão
 *   POST /notifications  notificações (orders_v2) → pedido relido na API → ingestão
 *
 * Implantada sem verificação de JWT (callback e notificações vêm do Mercado
 * Livre); /connect confere o JWT de quem chamou pela RPC `oauth_begin`.
 * As notificações não têm assinatura: valem só com o application_id do app,
 * para um usuário conectado, e o pedido é sempre relido com o token dele.
 *
 * Segredos: MERCADOLIVRE_CLIENT_ID, MERCADOLIVRE_CLIENT_SECRET,
 * CREDENTIALS_ENCRYPTION_KEY e APP_URL (endereço do app, para voltar depois
 * do OAuth). Sem eles: "not_configured".
 *
 * ATENÇÃO: roda em Deno e não foi executada nos testes do projeto; a lógica
 * pura está em `_shared/integrations/mercadolivre.ts` (testada). Valide com
 * um usuário de teste do Mercado Livre antes de produção.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { NormalizeError } from '../_shared/integrations/common.ts';
import { encryptCredentials } from '../_shared/integrations/crypto.ts';
import {
  ML_API,
  authorizationUrl,
  codeChallenge,
  expiresAt,
  generateCodeVerifier,
  mlGet,
  normalizeMercadoLivreOrder,
  parseNotification,
  parseTokenResponse,
} from '../_shared/integrations/mercadolivre.ts';
import { mlAccessToken } from '../_shared/integrations/mltoken.ts';
import { StockPushError } from '../_shared/integrations/stock.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });

const config = () => {
  const clientId = Deno.env.get('MERCADOLIVRE_CLIENT_ID');
  const clientSecret = Deno.env.get('MERCADOLIVRE_CLIENT_SECRET');
  const key = Deno.env.get('CREDENTIALS_ENCRYPTION_KEY');
  const appUrl = Deno.env.get('APP_URL')?.replace(/\/+$/, '');
  if (!clientId || !clientSecret || !key || !appUrl || !/^https?:\/\//.test(appUrl)) return null;
  return {
    clientId,
    clientSecret,
    key,
    appUrl,
    redirectUri: `${Deno.env.get('SUPABASE_URL')}/functions/v1/mercadolivre/callback`,
  };
};

const service = () =>
  createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const redirect = (url: string) => new Response(null, { status: 302, headers: { location: url } });

async function connect(req: Request) {
  const cfg = config();
  if (!cfg) return json(503, { error: 'not_configured' });
  const authorization = req.headers.get('Authorization');
  if (!authorization) return json(401, { error: 'unauthorized' });
  let input: Record<string, unknown>;
  try {
    input = await req.json();
  } catch {
    return json(400, { error: 'invalid_body' });
  }
  const orgId = String(input.organization_id ?? '');
  const name = String(input.name ?? '').trim();
  if (!UUID.test(orgId) || name.length < 2 || name.length > 80)
    return json(400, { error: 'invalid_body' });

  const asCaller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const verifier = generateCodeVerifier();
  const { data: state, error } = await asCaller.rpc('oauth_begin', {
    p_org: orgId,
    p_provider: 'mercadolivre',
    p_name: name,
    p_code_verifier: verifier,
  });
  if (error) {
    if (/forbidden|sellers_only/.test(error.message)) return json(403, { error: 'forbidden' });
    if (/jwt/i.test(error.message)) return json(401, { error: 'unauthorized' });
    return json(400, { error: 'invalid_body' });
  }
  return json(200, {
    url: authorizationUrl({
      clientId: cfg.clientId,
      redirectUri: cfg.redirectUri,
      state: String(state),
      challenge: await codeChallenge(verifier),
    }),
  });
}

async function callback(url: URL) {
  const cfg = config();
  if (!cfg) return json(503, { error: 'not_configured' });
  const back = (query: string) => redirect(`${cfg.appUrl}/integracoes?${query}`);
  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  if (url.searchParams.get('error') || !code || !UUID.test(state)) return back('ml=cancelado');

  const db = service();
  const consumed = await db.rpc('oauth_consume', { p_state: state });
  if (consumed.error) return back('ml=expirado');
  const s = consumed.data as {
    organization_id: string;
    user_id: string;
    name: string;
    code_verifier: string;
  };

  let tokens;
  try {
    const res = await fetch(`${ML_API}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        redirect_uri: cfg.redirectUri,
        code_verifier: s.code_verifier,
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`token HTTP ${res.status}`);
    tokens = parseTokenResponse(await res.json());
  } catch (e) {
    console.error(
      'mercadolivre callback: troca do código falhou',
      e instanceof Error ? e.message : '',
    );
    return back('ml=erro');
  }

  const created = await db.rpc('oauth_complete', {
    p_org: s.organization_id,
    p_user: s.user_id,
    p_provider: 'mercadolivre',
    p_name: s.name,
    p_account: tokens.user_id,
    p_ciphertext: null,
    p_config: null,
  });
  if (created.error) {
    return back(
      created.error.message === 'integrations.account_in_use' ? 'ml=conta_em_uso' : 'ml=erro',
    );
  }
  const connectionId = String(created.data);
  const stored = await db.rpc('put_connection_credentials', {
    p_connection: connectionId,
    p_ciphertext: await encryptCredentials(
      cfg.key,
      JSON.stringify({ access_token: tokens.access_token, refresh_token: tokens.refresh_token }),
      connectionId,
    ),
    p_config: {
      token_version: 1,
      expires_at: expiresAt(new Date(), tokens.expires_in),
      user_id: tokens.user_id,
    },
  });
  if (stored.error) {
    console.error('mercadolivre callback: falha ao guardar credenciais', stored.error.message);
    return back('ml=erro');
  }
  return redirect(`${cfg.appUrl}/integracoes/${connectionId}?ml=conectado`);
}

async function notifications(req: Request) {
  const cfg = config();
  // 503: o Mercado Livre tenta de novo depois.
  if (!cfg) return json(503, { error: 'not_configured' });
  const raw = await req.text();
  if (raw.length > 10_000) return json(413, { error: 'too_large' });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(200, { ok: true, ignored: 'not_json' });
  }
  const n = parseNotification(body, cfg.clientId);
  if (!n) return json(200, { ok: true, ignored: 'topic' });

  const db = service();
  const { data: connectionId } = await db.rpc('mercadolivre_connection', { p_user_id: n.userId });
  if (!connectionId) return json(200, { ok: true, ignored: 'no_connection' });

  try {
    const token = await mlAccessToken(db, fetch, String(connectionId));
    const order = (await mlGet(fetch, token, `/orders/${n.resourceId}`)) as Record<string, unknown>;
    const shippingId = (order.shipping as Record<string, unknown> | null)?.id;
    const shipment = shippingId
      ? await mlGet(fetch, token, `/shipments/${String(shippingId)}`, { 'x-format-new': 'true' })
      : null;
    const result = normalizeMercadoLivreOrder(order, shipment);
    if (result.kind === 'skip') return json(200, { ok: true, skipped: result.reason });
    const { data, error } = await db.rpc('ingest_marketplace_order', {
      p_connection: connectionId,
      p_external_id: result.externalId,
      p_order: result.order,
    });
    if (error) {
      console.error('mercadolivre: falha na ingestão', error.message);
      return json(500, { error: 'ingest_failed' });
    }
    return json(200, { ok: true, result: data });
  } catch (e) {
    if (e instanceof NormalizeError) {
      console.error('mercadolivre: pedido inutilizável', e.message);
      return json(200, { ok: true, ignored: 'unprocessable' });
    }
    console.error(
      'mercadolivre: falha',
      e instanceof StockPushError ? e.message : 'erro inesperado',
    );
    return json(502, { error: 'provider_unavailable' });
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  if (req.method === 'GET' && path.endsWith('/callback')) return callback(url);
  if (req.method === 'GET' && path.endsWith('/status')) {
    return json(200, { configured: config() !== null });
  }
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (path.endsWith('/connect')) return connect(req);
  if (path.endsWith('/notifications')) return notifications(req);
  return json(404, { error: 'not_found' });
});
