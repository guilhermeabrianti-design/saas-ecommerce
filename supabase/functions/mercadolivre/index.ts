/**
 * Mercado Livre (Fase 31): /functions/v1/mercadolivre/...
 *
 *   POST /connect        (JWT) começa o OAuth: devolve a URL de autorização
 *   GET  /callback       volta do Mercado Livre: troca o código, cria a conexão
 *   POST /notifications  notificações (orders_v2, shipments) → pedido relido na API →
 *                        ingestão → encaminhamento ao fornecedor → etiqueta e nota
 *   POST /documents      (JWT) relê um pedido e busca etiqueta e nota (botão do pedido)
 *   POST /categories     (JWT) sugere categorias pelo título (Fase 37)
 *   POST /category       (JWT) nome e atributos de uma categoria (Fase 37)
 *   POST /publish        (JWT) publica/atualiza, pausa ou reativa o anúncio do produto (Fase 37)
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
  availableDocuments,
  downloadDocument,
  fetchOrderInvoice,
  codeChallenge,
  expiresAt,
  generateCodeVerifier,
  mlGet,
  normalizeMercadoLivreOrder,
  parseNotification,
  parseTokenResponse,
} from '../_shared/integrations/mercadolivre.ts';
import {
  ML_MAX_PICTURES,
  buildMlItem,
  buildMlUpdate,
  existingVariationSkus,
  mlSend,
  parseCategoryAttributes,
  parseCategorySuggestions,
  parseItem,
  publishStatus,
  validCategoryId,
  type PublishData,
} from '../_shared/integrations/mlpublish.ts';
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

type Db = ReturnType<typeof service>;

interface Forward {
  status: string;
  order_id?: string;
  supplier_order_id: string | null;
  target_order_id: string | null;
  existing: string[];
}

/**
 * Relê o pedido no Mercado Livre, ingere (duplicado é ok), encaminha ao
 * fornecedor e anexa etiqueta e nota fiscal disponíveis.
 */
async function processOrder(db: Db, connectionId: string, mlUserId: string, orderId: string) {
  const token = await mlAccessToken(db, fetch, connectionId);
  const order = (await mlGet(fetch, token, `/orders/${orderId}`)) as Record<string, unknown>;
  const shippingId = (order.shipping as Record<string, unknown> | null)?.id;
  const shipmentId = shippingId ? String(shippingId) : null;
  const shipment = shipmentId
    ? await mlGet(fetch, token, `/shipments/${shipmentId}`, { 'x-format-new': 'true' })
    : null;
  const result = normalizeMercadoLivreOrder(order, shipment);
  if (result.kind === 'skip') return { ok: true, skipped: result.reason };

  const ingested = await db.rpc('ingest_marketplace_order', {
    p_connection: connectionId,
    p_external_id: result.externalId,
    p_order: result.order,
  });
  if (ingested.error) throw new Error(`ingest: ${ingested.error.message}`);

  const fwd = await db.rpc('ml_forward_order', {
    p_connection: connectionId,
    p_external_id: result.externalId,
    p_shipment_id: shipmentId,
  });
  if (fwd.error) throw new Error(`forward: ${fwd.error.message}`);
  const f = fwd.data as Forward;
  if (f.status === 'no_order' || !f.order_id) return { ok: true, result: ingested.data };
  // Pedido ainda pendente (encaminhamento desligado ou falhou): documentos ficam para depois.
  if (f.status === 'pending' || f.status === 'cancelled') {
    return { ok: true, result: ingested.data, status: f.status };
  }

  const invoice = await fetchOrderInvoice(fetch, token, mlUserId, result.externalId);
  const folder = f.supplier_order_id ? `so-${f.supplier_order_id}` : `o-${f.target_order_id}`;
  const attached: string[] = [];
  for (const doc of availableDocuments({ shipmentId, shipment, invoice })) {
    if (f.existing.includes(`${doc.kind}:${doc.ref}`)) continue;
    const bytes = await downloadDocument(fetch, token, doc);
    const path = `${folder}/ml-${doc.kind}-${doc.ref}.${doc.extension}`;
    const up = await db.storage
      .from('shipping-labels')
      .upload(path, bytes, { contentType: doc.contentType, upsert: true });
    if (up.error) throw new Error(`storage: ${up.error.message}`);
    const reg = await db.rpc('attach_marketplace_document', {
      p_order: f.order_id,
      p_kind: doc.kind,
      p_path: path,
      p_file_name: doc.fileName,
      p_external_ref: doc.ref,
      p_tracking_code: doc.tracking ?? null,
    });
    if (reg.error) throw new Error(`attach: ${reg.error.message}`);
    attached.push(doc.kind);
  }
  return { ok: true, result: ingested.data, status: f.status, attached };
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

  let orderId = n.resourceId;
  if (n.topic === 'shipments') {
    // Só envios de pedidos que já entraram (o pedido chega pelo orders_v2).
    const { data } = await db.rpc('ml_external_by_shipment', {
      p_connection: connectionId,
      p_shipment_id: n.resourceId,
    });
    if (!data) return json(200, { ok: true, ignored: 'unknown_shipment' });
    orderId = String(data);
  }
  return run(() => processOrder(db, String(connectionId), n.userId, orderId));
}

/** Botão "Buscar no Mercado Livre" do pedido (JWT de um membro do vendedor). */
async function documents(req: Request) {
  if (!config()) return json(503, { error: 'not_configured' });
  const authorization = req.headers.get('Authorization');
  if (!authorization) return json(401, { error: 'unauthorized' });
  let input: Record<string, unknown>;
  try {
    input = await req.json();
  } catch {
    return json(400, { error: 'invalid_body' });
  }
  const orderId = String(input.order_id ?? '');
  if (!UUID.test(orderId)) return json(400, { error: 'invalid_body' });

  const asCaller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await asCaller.rpc('ml_documents_request', { p_order: orderId });
  if (error) {
    if (/jwt/i.test(error.message)) return json(401, { error: 'unauthorized' });
    if (error.message === 'rate_limited') return json(429, { error: 'rate_limited' });
    return json(403, { error: 'forbidden' });
  }
  const row = (data as { connection_id: string; external_id: string }[] | null)?.[0];
  if (!row) return json(404, { error: 'not_mercadolivre' });

  const db = service();
  const { data: conn } = await db
    .from('integration_connections')
    .select('external_account_id')
    .eq('id', row.connection_id)
    .single();
  if (!conn) return json(404, { error: 'not_mercadolivre' });
  return run(() =>
    processOrder(db, row.connection_id, String(conn.external_account_id), row.external_id),
  );
}

const callerClient = (authorization: string) =>
  createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Confere o JWT e o limite de consultas (vendedor). Devolve a resposta de erro ou null. */
async function lookupGate(req: Request): Promise<Response | null> {
  const authorization = req.headers.get('Authorization');
  if (!authorization) return json(401, { error: 'unauthorized' });
  const { error } = await callerClient(authorization).rpc('ml_lookup_allowed');
  if (!error) return null;
  if (/jwt/i.test(error.message)) return json(401, { error: 'unauthorized' });
  if (error.message === 'rate_limited') return json(429, { error: 'rate_limited' });
  return json(403, { error: 'forbidden' });
}

/** Sugestões de categoria pelo título (API pública de categorias). */
async function categories(req: Request) {
  const gate = await lookupGate(req);
  if (gate) return gate;
  const input = await readBody(req);
  const q = String(input?.q ?? '').trim();
  if (q.length < 3 || q.length > 120) return json(400, { error: 'invalid_body' });
  return run(async () => {
    const body = await mlSend(
      fetch,
      null,
      'GET',
      `/sites/MLB/domain_discovery/search?limit=8&q=${encodeURIComponent(q)}`,
    );
    return { suggestions: parseCategorySuggestions(body) };
  });
}

/** Nome, caminho e atributos de uma categoria. */
async function category(req: Request) {
  const gate = await lookupGate(req);
  if (gate) return gate;
  const input = await readBody(req);
  const id = String(input?.category_id ?? '').toUpperCase();
  if (!validCategoryId(id)) return json(400, { error: 'invalid_body' });
  return run(async () => {
    const [info, attrs] = await Promise.all([
      mlSend(fetch, null, 'GET', `/categories/${id}`),
      mlSend(fetch, null, 'GET', `/categories/${id}/attributes`),
    ]);
    const c = info as { name?: unknown; path_from_root?: unknown };
    const path = Array.isArray(c.path_from_root)
      ? c.path_from_root
          .map((p) => String((p as { name?: unknown }).name ?? ''))
          .filter(Boolean)
          .join(' › ')
      : '';
    return {
      category_id: id,
      name: String(c.name ?? id).slice(0, 120),
      path: path.slice(0, 400),
      attributes: parseCategoryAttributes(attrs),
    };
  });
}

const beginErrors: Record<string, number> = {
  'products.not_found': 404,
  'channels.sellers_only': 403,
  rate_limited: 429,
  'ml.busy': 409,
};

/**
 * Publica (cria ou atualiza), pausa ou reativa o anúncio do produto.
 * `ml_publish_begin` (JWT de quem chamou) confere permissão e estado; o
 * resultado sempre é gravado por `ml_publish_finish`, inclusive a falha.
 */
async function publish(req: Request) {
  if (!config()) return json(503, { error: 'not_configured' });
  const authorization = req.headers.get('Authorization');
  if (!authorization) return json(401, { error: 'unauthorized' });
  const input = await readBody(req);
  const productId = String(input?.product_id ?? '');
  const action = String(input?.action ?? '');
  if (!UUID.test(productId) || !['publish', 'pause', 'activate'].includes(action))
    return json(400, { error: 'invalid_body' });

  const { data: begun, error } = await callerClient(authorization).rpc('ml_publish_begin', {
    p_product: productId,
    p_action: action,
  });
  if (error) {
    if (/jwt/i.test(error.message)) return json(401, { error: 'unauthorized' });
    return json(beginErrors[error.message] ?? 422, { error: error.message });
  }
  const data = begun as PublishData;
  const db = service();
  const finish = (args: {
    ok: boolean;
    externalId?: string | null;
    url?: string | null;
    status?: string | null;
    error?: string | null;
    links?: unknown;
  }) =>
    db.rpc('ml_publish_finish', {
      p_run: data.run_id,
      p_ok: args.ok,
      p_external_id: args.externalId ?? null,
      p_external_url: args.url ?? null,
      p_status: args.status ?? null,
      p_error: args.error ?? null,
      p_links: args.links ?? [],
    });

  try {
    const token = await mlAccessToken(db, fetch, data.connection_id);

    if (data.action !== 'publish') {
      const item = await mlSend(fetch, token, 'PUT', `/items/${data.external_id}`, {
        status: data.action === 'pause' ? 'paused' : 'active',
      });
      const status = publishStatus(item);
      const done = await finish({ ok: true, status });
      if (done.error) throw new Error(`finish: ${done.error.message}`);
      return json(200, { ok: true, status });
    }

    const existing = data.external_id
      ? await mlSend(fetch, token, 'GET', `/items/${data.external_id}`)
      : null;
    const attrs = parseCategoryAttributes(
      await mlSend(fetch, null, 'GET', `/categories/${String(data.config.category)}/attributes`),
    );
    const pictures: string[] = [];
    for (const path of data.images.slice(0, ML_MAX_PICTURES)) {
      // O Mercado Livre baixa a foto na hora; 1 hora sobra.
      const signed = await db.storage.from('product-images').createSignedUrl(path, 3600);
      if (signed.data?.signedUrl) pictures.push(signed.data.signedUrl);
    }

    const built = buildMlItem(data, pictures, attrs, {
      existingVariationSkus: existing ? existingVariationSkus(existing) : [],
    });
    if (!built.ok) {
      await finish({ ok: false, error: built.errors.join(' ') });
      return json(422, { error: 'invalid_listing', messages: built.errors });
    }

    let item: unknown;
    if (data.external_id) {
      item = await mlSend(
        fetch,
        token,
        'PUT',
        `/items/${data.external_id}`,
        buildMlUpdate(existing, built.item),
      );
      if (built.item.description) {
        await mlSend(fetch, token, 'PUT', `/items/${data.external_id}/description`, {
          plain_text: built.item.description,
        });
      }
    } else {
      item = await mlSend(fetch, token, 'POST', '/items', built.item.body);
      const created = parseItem(item);
      if (built.item.description) {
        // O anúncio já existe: falha na descrição não desfaz a publicação.
        await mlSend(fetch, token, 'POST', `/items/${created.id}/description`, {
          plain_text: built.item.description,
        }).catch((e: unknown) =>
          console.error('mercadolivre publish: descrição', e instanceof Error ? e.message : ''),
        );
      }
    }
    const parsed = parseItem(item);
    const status = publishStatus(item);
    const done = await finish({
      ok: true,
      externalId: parsed.id,
      url: parsed.permalink,
      status,
      links: built.item.links,
    });
    if (done.error) throw new Error(`finish: ${done.error.message}`);
    return json(200, {
      ok: true,
      external_id: parsed.id,
      url: parsed.permalink,
      status,
      skipped: built.item.skipped,
    });
  } catch (e) {
    const message =
      e instanceof StockPushError ? e.message : 'Falha inesperada ao falar com o Mercado Livre.';
    if (!(e instanceof StockPushError))
      console.error('mercadolivre publish: falha', e instanceof Error ? e.message : '');
    await finish({ ok: false, error: message });
    return json(502, { error: 'provider_error', message });
  }
}

async function run(fn: () => Promise<Record<string, unknown>>) {
  try {
    return json(200, await fn());
  } catch (e) {
    if (e instanceof NormalizeError) {
      console.error('mercadolivre: pedido inutilizável', e.message);
      return json(200, { ok: true, ignored: 'unprocessable' });
    }
    if (e instanceof StockPushError) {
      console.error('mercadolivre: falha', e.message);
      return json(502, { error: 'provider_unavailable', message: e.message });
    }
    console.error('mercadolivre: falha', e instanceof Error ? e.message : 'erro inesperado');
    return json(500, { error: 'internal' });
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
  if (path.endsWith('/documents')) return documents(req);
  if (path.endsWith('/categories')) return categories(req);
  if (path.endsWith('/category')) return category(req);
  if (path.endsWith('/publish')) return publish(req);
  return json(404, { error: 'not_found' });
});
