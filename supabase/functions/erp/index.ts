/**
 * ERP (Fase 36): /functions/v1/erp/...
 *
 *   POST /connect-bling  (JWT) começa o OAuth do Bling: devolve a URL de autorização
 *   GET  /callback       volta do Bling: troca o código, cria a conexão, 1ª sincronização
 *   POST /connect-tiny   (JWT) { organization_id, name, token } confere o token do Tiny e conecta
 *   POST /sync           (JWT) { connection_id } sincroniza agora (owner/admin)
 *   POST /cron           (x-sync-secret) sincroniza as conexões ativas (agendador)
 *
 * O ERP é a fonte do saldo: lemos o estoque dos nossos SKUs (Bling) ou as
 * atualizações desde a última leitura (Tiny) e aplicamos com
 * `erp_apply_stock`. Credenciais cifradas (CREDENTIALS_ENCRYPTION_KEY),
 * decifradas só em memória e nunca registradas.
 *
 * Segredos: CREDENTIALS_ENCRYPTION_KEY, APP_URL, STOCK_SYNC_SECRET (cron) e,
 * para o Bling, BLING_CLIENT_ID e BLING_CLIENT_SECRET (app criado em
 * developer.bling.com.br com a URL de retorno `<SUPABASE_URL>/functions/v1/erp/callback`).
 *
 * ATENÇÃO: roda em Deno e não foi executada nos testes do projeto; a lógica
 * pura está em `_shared/integrations/erp.ts` (testada). Valide com contas
 * de teste do Bling e do Tiny antes de produção.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import {
  decryptCredentials,
  encryptCredentials,
  timingSafeEqualText,
} from '../_shared/integrations/crypto.ts';
import {
  TINY_FIRST_CURSOR,
  blingAuthorizationUrl,
  blingStock,
  blingToken,
  tinyCheckToken,
  tinyCursor,
  tinyStockUpdates,
  type BlingTokens,
} from '../_shared/integrations/erp.ts';
import {
  expiresAt,
  generateCodeVerifier,
  needsRefresh,
} from '../_shared/integrations/mercadolivre.ts';
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

const redirect = (url: string) => new Response(null, { status: 302, headers: { location: url } });

const env = () => {
  const key = Deno.env.get('CREDENTIALS_ENCRYPTION_KEY');
  const appUrl = Deno.env.get('APP_URL')?.replace(/\/+$/, '');
  if (!key || !appUrl || !/^https?:\/\//.test(appUrl)) return null;
  return {
    key,
    appUrl,
    blingId: Deno.env.get('BLING_CLIENT_ID') ?? '',
    blingSecret: Deno.env.get('BLING_CLIENT_SECRET') ?? '',
  };
};

type Db = SupabaseClient;

const service = (): Db =>
  createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const asCaller = (authorization: string): Db =>
  createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const raw = await req.text();
    if (raw.length > 5_000) return null;
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Credenciais
// ---------------------------------------------------------------------

interface Stored {
  secret: Record<string, string>;
  config: { token_version?: number; expires_at?: string };
}

async function readCredentials(db: Db, key: string, connectionId: string): Promise<Stored> {
  const { data, error } = await db
    .from('integration_credentials')
    .select('ciphertext, config')
    .eq('connection_id', connectionId)
    .maybeSingle();
  if (error || !data) throw new StockPushError('credenciais não encontradas (reconecte)');
  try {
    return {
      secret: JSON.parse(await decryptCredentials(key, data.ciphertext, connectionId)),
      config: (data.config ?? {}) as Stored['config'],
    };
  } catch {
    throw new StockPushError('não foi possível decifrar as credenciais');
  }
}

async function storeBling(
  db: Db,
  key: string,
  connectionId: string,
  t: BlingTokens,
  version: number,
) {
  const { error } = await db.rpc('put_connection_credentials', {
    p_connection: connectionId,
    p_ciphertext: await encryptCredentials(
      key,
      JSON.stringify({ access_token: t.access_token, refresh_token: t.refresh_token }),
      connectionId,
    ),
    p_config: { token_version: version, expires_at: expiresAt(new Date(), t.expires_in) },
  });
  if (error) throw new Error(`credenciais: ${error.message}`);
}

/** Token do Bling válido, renovando com gravação por versão (refresh de uso único). */
async function blingAccess(db: Db, cfg: NonNullable<ReturnType<typeof env>>, connectionId: string) {
  const current = await readCredentials(db, cfg.key, connectionId);
  if (!needsRefresh(current.config.expires_at, new Date())) return current.secret.access_token!;
  if (!cfg.blingId || !cfg.blingSecret) throw new StockPushError('Bling não configurado');
  const version = current.config.token_version ?? 0;
  let next: BlingTokens;
  try {
    next = await blingToken(fetch, {
      clientId: cfg.blingId,
      clientSecret: cfg.blingSecret,
      body: { grant_type: 'refresh_token', refresh_token: current.secret.refresh_token! },
    });
  } catch (e) {
    const latest = await readCredentials(db, cfg.key, connectionId);
    if ((latest.config.token_version ?? 0) !== version) return latest.secret.access_token!;
    throw e;
  }
  const { data } = await db.rpc('swap_connection_credentials', {
    p_connection: connectionId,
    p_expected_version: version,
    p_ciphertext: await encryptCredentials(
      cfg.key,
      JSON.stringify({ access_token: next.access_token, refresh_token: next.refresh_token }),
      connectionId,
    ),
    p_config: { token_version: version + 1, expires_at: expiresAt(new Date(), next.expires_in) },
  });
  if (data === true) return next.access_token;
  return (await readCredentials(db, cfg.key, connectionId)).secret.access_token!;
}

// ---------------------------------------------------------------------
// Sincronização
// ---------------------------------------------------------------------

async function syncConnection(
  db: Db,
  cfg: NonNullable<ReturnType<typeof env>>,
  connectionId: string,
): Promise<Record<string, unknown>> {
  const { data: conn, error } = await db
    .from('integration_connections')
    .select('provider, sync_cursor, status')
    .eq('id', connectionId)
    .single();
  if (error || !conn) throw new Error('conexão não encontrada');
  if (conn.status !== 'active') return { status: 'inactive' };

  try {
    let rows;
    let cursor: string | null = null;
    if (conn.provider === 'bling') {
      const token = await blingAccess(db, cfg, connectionId);
      const { data: skus, error: skuError } = await db.rpc('erp_skus', {
        p_connection: connectionId,
      });
      if (skuError) throw new Error(skuError.message);
      rows = await blingStock(
        fetch,
        token,
        ((skus ?? []) as { sku: string }[]).map((s) => s.sku),
      );
    } else {
      const creds = await readCredentials(db, cfg.key, connectionId);
      // O cursor é marcado antes da leitura: o que mudar durante entra na próxima.
      cursor = tinyCursor(new Date());
      rows = await tinyStockUpdates(
        fetch,
        creds.secret.token!,
        conn.sync_cursor ?? TINY_FIRST_CURSOR,
      );
    }
    const { data: summary, error: applyError } = await db.rpc('erp_apply_stock', {
      p_connection: connectionId,
      p_rows: rows,
      p_cursor: cursor,
    });
    if (applyError) throw new Error(applyError.message);
    return { status: 'ok', summary };
  } catch (e) {
    const message = e instanceof StockPushError ? e.message : 'falha inesperada na sincronização';
    if (!(e instanceof StockPushError))
      console.error('erp: falha', e instanceof Error ? e.message : '');
    await db.rpc('erp_sync_failed', { p_connection: connectionId, p_message: message });
    return { status: 'error', message };
  }
}

// ---------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------

async function connectBling(req: Request) {
  const cfg = env();
  if (!cfg || !cfg.blingId || !cfg.blingSecret) return json(503, { error: 'not_configured' });
  const authorization = req.headers.get('Authorization');
  if (!authorization) return json(401, { error: 'unauthorized' });
  const input = await readBody(req);
  const orgId = String(input?.organization_id ?? '');
  const name = String(input?.name ?? '').trim();
  if (!UUID.test(orgId) || name.length < 2 || name.length > 80)
    return json(400, { error: 'invalid_body' });

  const { data: state, error } = await asCaller(authorization).rpc('oauth_begin', {
    p_org: orgId,
    p_provider: 'bling',
    p_name: name,
    p_code_verifier: generateCodeVerifier(),
  });
  if (error) {
    if (/forbidden/.test(error.message)) return json(403, { error: 'forbidden' });
    if (/jwt/i.test(error.message)) return json(401, { error: 'unauthorized' });
    return json(400, { error: 'invalid_body' });
  }
  return json(200, { url: blingAuthorizationUrl(cfg.blingId, String(state)) });
}

async function callback(url: URL) {
  const cfg = env();
  if (!cfg || !cfg.blingId || !cfg.blingSecret) return json(503, { error: 'not_configured' });
  const back = (query: string) => redirect(`${cfg.appUrl}/estoque/sincronizar?${query}`);
  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  if (url.searchParams.get('error') || !code || !UUID.test(state)) return back('erp=cancelado');

  const db = service();
  const consumed = await db.rpc('oauth_consume', { p_state: state });
  if (consumed.error) return back('erp=expirado');
  const s = consumed.data as {
    organization_id: string;
    user_id: string;
    name: string;
    provider: string;
  };
  if (s.provider !== 'bling') return back('erp=erro');

  let tokens: BlingTokens;
  try {
    tokens = await blingToken(fetch, {
      clientId: cfg.blingId,
      clientSecret: cfg.blingSecret,
      body: { grant_type: 'authorization_code', code },
    });
  } catch (e) {
    console.error('erp callback: troca do código falhou', e instanceof Error ? e.message : '');
    return back('erp=erro');
  }
  const created = await db.rpc('erp_upsert_connection', {
    p_org: s.organization_id,
    p_user: s.user_id,
    p_provider: 'bling',
    p_name: s.name,
  });
  if (created.error) return back('erp=erro');
  const connectionId = String(created.data);
  try {
    await storeBling(db, cfg.key, connectionId, tokens, 1);
  } catch {
    return back('erp=erro');
  }
  await syncConnection(db, cfg, connectionId);
  return back('erp=conectado');
}

async function connectTiny(req: Request) {
  const cfg = env();
  if (!cfg) return json(503, { error: 'not_configured' });
  const authorization = req.headers.get('Authorization');
  if (!authorization) return json(401, { error: 'unauthorized' });
  const input = await readBody(req);
  const orgId = String(input?.organization_id ?? '');
  const name = String(input?.name ?? '').trim();
  const token = String(input?.token ?? '').trim();
  if (
    !UUID.test(orgId) ||
    name.length < 2 ||
    name.length > 80 ||
    !/^[A-Za-z0-9]{20,128}$/.test(token)
  )
    return json(400, { error: 'invalid_body' });

  const { data: user, error: userError } = await asCaller(authorization).auth.getUser();
  if (userError || !user.user) return json(401, { error: 'unauthorized' });

  try {
    await tinyCheckToken(fetch, token);
  } catch {
    return json(400, { error: 'invalid_token' });
  }
  const db = service();
  const created = await db.rpc('erp_upsert_connection', {
    p_org: orgId,
    p_user: user.user.id,
    p_provider: 'tiny',
    p_name: name,
  });
  if (created.error) {
    return json(/forbidden/.test(created.error.message) ? 403 : 400, {
      error: /forbidden/.test(created.error.message) ? 'forbidden' : 'invalid_body',
    });
  }
  const connectionId = String(created.data);
  const stored = await db.rpc('put_connection_credentials', {
    p_connection: connectionId,
    p_ciphertext: await encryptCredentials(cfg.key, JSON.stringify({ token }), connectionId),
    p_config: {},
  });
  if (stored.error) return json(500, { error: 'internal' });
  const result = await syncConnection(db, cfg, connectionId);
  return json(200, { connection_id: connectionId, ...result });
}

async function syncNow(req: Request) {
  const cfg = env();
  if (!cfg) return json(503, { error: 'not_configured' });
  const authorization = req.headers.get('Authorization');
  if (!authorization) return json(401, { error: 'unauthorized' });
  const input = await readBody(req);
  const connectionId = String(input?.connection_id ?? '');
  if (!UUID.test(connectionId)) return json(400, { error: 'invalid_body' });

  const { error } = await asCaller(authorization).rpc('erp_sync_request', {
    p_connection: connectionId,
  });
  if (error) {
    if (error.message === 'rate_limited') return json(429, { error: 'rate_limited' });
    if (/jwt/i.test(error.message)) return json(401, { error: 'unauthorized' });
    if (error.message === 'integrations.disconnected') return json(409, { error: 'disconnected' });
    return json(404, { error: 'not_found' });
  }
  return json(200, await syncConnection(service(), cfg, connectionId));
}

async function cron(req: Request) {
  const cfg = env();
  const expected = Deno.env.get('STOCK_SYNC_SECRET');
  if (!cfg || !expected) return json(503, { error: 'not_configured' });
  if (!timingSafeEqualText(req.headers.get('x-sync-secret') ?? '', expected)) {
    return json(401, { error: 'unauthorized' });
  }
  const db = service();
  const { data, error } = await db.rpc('erp_due_connections', { p_limit: 10 });
  if (error) return json(500, { error: 'claim_failed' });
  let ok = 0;
  let failed = 0;
  for (const row of (data ?? []) as { connection_id: string }[]) {
    const r = await syncConnection(db, cfg, row.connection_id);
    if (r.status === 'error') failed++;
    else ok++;
  }
  return json(200, { ok, failed });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  if (req.method === 'GET' && path.endsWith('/callback')) return callback(url);
  if (req.method === 'GET' && path.endsWith('/status')) {
    const cfg = env();
    return json(200, { configured: cfg !== null, bling: !!(cfg?.blingId && cfg?.blingSecret) });
  }
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (path.endsWith('/connect-bling')) return connectBling(req);
  if (path.endsWith('/connect-tiny')) return connectTiny(req);
  if (path.endsWith('/sync')) return syncNow(req);
  if (path.endsWith('/cron')) return cron(req);
  return json(404, { error: 'not_found' });
});
