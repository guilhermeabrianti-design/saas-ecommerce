/**
 * TikTok Shop (Fase 39): /functions/v1/tiktok/...
 *
 *   GET  /status     se a TikTok Shop está configurada na plataforma
 *   POST /connect    (JWT) começa a autorização da loja: devolve a URL
 *   GET  /callback   volta da TikTok Shop (?code&state): troca o código, acha a loja
 *                    (prefere a do Brasil), cria a conexão
 *   POST /webhook    notificações assinadas (pedido mudou de status) → pedido relido na
 *                    API → ingestão → encaminhamento → envio por postagem → etiqueta
 *   POST /documents  (JWT) relê um pedido e busca a etiqueta (botão do pedido)
 *   POST /categories (JWT) sugere categorias pelo título (Fase 44)
 *   POST /category   (JWT) nome, caminho e atributos de uma categoria (Fase 44)
 *   POST /publish    (JWT) publica/atualiza, pausa ou reativa o produto (Fase 44)
 *
 * Implantada sem verificação de JWT (callback e webhook vêm da TikTok Shop);
 * /connect e /documents conferem o JWT de quem chamou pelas RPCs. O webhook
 * vale só com a assinatura da app secret, para uma loja conectada, e o
 * pedido é sempre relido com o token dela.
 *
 * Segredos: TIKTOK_APP_KEY, TIKTOK_APP_SECRET, TIKTOK_SERVICE_ID,
 * CREDENTIALS_ENCRYPTION_KEY e APP_URL. Sem eles: "not_configured". No
 * Partner Center, o endereço de volta é <SUPABASE_URL>/functions/v1/tiktok/callback
 * e o webhook de pedidos <SUPABASE_URL>/functions/v1/tiktok/webhook.
 *
 * ATENÇÃO: roda em Deno e não foi executada nos testes do projeto; a lógica
 * pura está em `_shared/integrations/tiktok.ts` (testada). Valide com uma
 * loja de teste da TikTok Shop antes de produção.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { NormalizeError } from '../_shared/integrations/common.ts';
import { encryptCredentials } from '../_shared/integrations/crypto.ts';
import { expiresAt, generateCodeVerifier } from '../_shared/integrations/mercadolivre.ts';
import { StockPushError } from '../_shared/integrations/stock.ts';
import {
  ORDER_ID,
  authorizationUrl,
  fetchTikTokLabel,
  normalizeTikTokOrder,
  parseTikTokWebhook,
  pickShop,
  requestTikTokTokens,
  shipPackageDropOff,
  tiktokClient,
  tiktokPackages,
  verifyTikTokWebhook,
  type TikTokClient,
} from '../_shared/integrations/tiktok.ts';
import {
  categoryPath,
  searchCategories,
  type CategoryNode,
} from '../_shared/integrations/publishcommon.ts';
import { beginPublish, finishPublish, productImages } from '../_shared/integrations/publishflow.ts';
import {
  TIKTOK_LOCALE,
  TIKTOK_MAX_IMAGES,
  buildTikTokProduct,
  defaultWarehouse,
  parseTikTokAttributes,
  parseTikTokCategories,
  parseTikTokRecommend,
  tiktokProductStatus,
  tiktokSkuIds,
  uploadTikTokImage,
  validTikTokCategory,
} from '../_shared/integrations/tiktokpublish.ts';
import {
  tiktokAppFromEnv,
  tiktokShopClient,
  tiktokShopSession,
} from '../_shared/integrations/tiktoktoken.ts';

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
  const app = tiktokAppFromEnv();
  const key = Deno.env.get('CREDENTIALS_ENCRYPTION_KEY');
  const appUrl = Deno.env.get('APP_URL')?.replace(/\/+$/, '');
  if (!app || !key || !appUrl || !/^https?:\/\//.test(appUrl)) return null;
  return { app, key, appUrl };
};

const service = () =>
  createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const callerClient = (authorization: string) =>
  createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

const redirect = (url: string) => new Response(null, { status: 302, headers: { location: url } });

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function connect(req: Request) {
  const cfg = config();
  if (!cfg) return json(503, { error: 'not_configured' });
  const authorization = req.headers.get('Authorization');
  if (!authorization) return json(401, { error: 'unauthorized' });
  const input = await readBody(req);
  const orgId = String(input?.organization_id ?? '');
  const name = String(input?.name ?? '').trim();
  if (!UUID.test(orgId) || name.length < 2 || name.length > 80)
    return json(400, { error: 'invalid_body' });

  // A TikTok Shop não usa PKCE: o verifier só cumpre o formato do estado.
  const { data: state, error } = await callerClient(authorization).rpc('oauth_begin', {
    p_org: orgId,
    p_provider: 'tiktok',
    p_name: name,
    p_code_verifier: generateCodeVerifier(),
  });
  if (error) {
    if (/forbidden|sellers_only/.test(error.message)) return json(403, { error: 'forbidden' });
    if (/jwt/i.test(error.message)) return json(401, { error: 'unauthorized' });
    return json(400, { error: 'invalid_body' });
  }
  return json(200, { url: authorizationUrl(cfg.app, String(state)) });
}

async function callback(url: URL) {
  const cfg = config();
  if (!cfg) return json(503, { error: 'not_configured' });
  const back = (query: string) => redirect(`${cfg.appUrl}/integracoes?${query}`);
  const code = url.searchParams.get('code') ?? url.searchParams.get('auth_code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  if (!code || code.length > 500 || !UUID.test(state)) return back('tiktok=cancelado');

  const db = service();
  const consumed = await db.rpc('oauth_consume', { p_state: state });
  if (consumed.error) return back('tiktok=expirado');
  const s = consumed.data as { organization_id: string; user_id: string; name: string };

  let tokens;
  let shop;
  try {
    tokens = await requestTikTokTokens(fetch, cfg.app, { code });
    const shops = await tiktokClient(fetch, cfg.app, { accessToken: tokens.access_token }).get(
      '/authorization/202309/shops',
    );
    shop = pickShop(shops);
  } catch (e) {
    console.error('tiktok callback: troca do código falhou', e instanceof Error ? e.message : '');
    return back('tiktok=erro');
  }
  if (!shop) return back('tiktok=sem_loja');

  const created = await db.rpc('oauth_complete', {
    p_org: s.organization_id,
    p_user: s.user_id,
    p_provider: 'tiktok',
    p_name: s.name,
    p_account: shop.id,
    p_ciphertext: null,
    p_config: null,
  });
  if (created.error) {
    return back(
      created.error.message === 'integrations.account_in_use'
        ? 'tiktok=conta_em_uso'
        : 'tiktok=erro',
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
      user_id: shop.id,
      shop_cipher: shop.cipher,
      region: shop.region,
    },
  });
  if (stored.error) {
    console.error('tiktok callback: falha ao guardar credenciais', stored.error.message);
    return back('tiktok=erro');
  }
  return redirect(`${cfg.appUrl}/integracoes/${connectionId}?tiktok=conectado`);
}

type Db = ReturnType<typeof service>;

interface Forward {
  status: string;
  order_id?: string;
  supplier_order_id: string | null;
  target_order_id: string | null;
  existing: string[];
}

async function logEvent(
  db: Db,
  connectionId: string,
  kind: string,
  externalId: string,
  status: 'ok' | 'error',
  message: string,
) {
  const { data } = await db
    .from('integration_connections')
    .select('organization_id')
    .eq('id', connectionId)
    .single();
  if (!data) return;
  await db.from('integration_events').insert({
    organization_id: data.organization_id,
    connection_id: connectionId,
    direction: 'inbound',
    kind,
    external_id: externalId,
    status,
    message: message.slice(0, 500),
  });
}

/** Organiza o envio dos pacotes por postagem (logística da TikTok Shop). */
async function arrange(
  db: Db,
  api: TikTokClient,
  connectionId: string,
  orderId: string,
  packages: string[],
) {
  for (const packageId of packages) {
    try {
      await shipPackageDropOff(api, packageId);
      await logEvent(
        db,
        connectionId,
        'shipment.arranged',
        orderId,
        'ok',
        `Envio do pacote ${packageId} organizado na TikTok Shop (postagem pelo fornecedor)`,
      );
    } catch (e) {
      await logEvent(
        db,
        connectionId,
        'shipment.manual',
        orderId,
        'error',
        `Não foi possível organizar o envio do pacote ${packageId}: ${e instanceof StockPushError ? e.message : 'erro inesperado'}. Organize na TikTok Shop.`,
      );
    }
  }
}

/**
 * Relê o pedido na TikTok Shop, ingere (duplicado é ok), encaminha ao
 * fornecedor, organiza o envio por postagem (quando a conexão encaminha
 * sozinha e a logística é da TikTok) e anexa as etiquetas dos pacotes.
 */
async function processOrder(db: Db, connectionId: string, orderId: string) {
  const api = await tiktokShopClient(db, fetch, connectionId);
  const detail = await api.get('/order/202309/orders', { ids: orderId });
  const order = Array.isArray(detail.orders) ? detail.orders[0] : null;
  if (!order) throw new NormalizeError('pedido não encontrado na TikTok Shop');

  const result = normalizeTikTokOrder(order);
  if (result.kind === 'skip') return { ok: true, skipped: result.reason };

  const ingested = await db.rpc('ingest_marketplace_order', {
    p_connection: connectionId,
    p_external_id: result.externalId,
    p_order: result.order,
  });
  if (ingested.error) throw new Error(`ingest: ${ingested.error.message}`);

  const fwd = await db.rpc('marketplace_forward_order', {
    p_connection: connectionId,
    p_external_id: result.externalId,
  });
  if (fwd.error) throw new Error(`forward: ${fwd.error.message}`);
  const f = fwd.data as Forward;
  if (f.status === 'no_order' || !f.order_id) return { ok: true, result: ingested.data };
  if (f.status === 'pending' || f.status === 'cancelled') {
    return { ok: true, result: ingested.data, status: f.status };
  }

  const o = order as Record<string, unknown>;
  // Logística própria do vendedor: sem etiqueta da TikTok Shop.
  if (String(o.shipping_type ?? 'TIKTOK') === 'SELLER') {
    return {
      ok: true,
      result: ingested.data,
      status: f.status,
      attached: [],
      waiting: 'logística própria: sem etiqueta da TikTok Shop',
    };
  }
  const packages = tiktokPackages(order).filter((p) => !f.existing.includes(`label:${p}`));
  if (packages.length === 0) {
    return { ok: true, result: ingested.data, status: f.status, attached: [] };
  }

  const { data: conn } = await db
    .from('integration_connections')
    .select('auto_forward')
    .eq('id', connectionId)
    .single();
  if (conn?.auto_forward && String(o.status) === 'AWAITING_SHIPMENT') {
    await arrange(db, api, connectionId, orderId, packages);
  }

  const folder = f.supplier_order_id ? `so-${f.supplier_order_id}` : `o-${f.target_order_id}`;
  const attached: string[] = [];
  let waiting: string | undefined;
  for (const packageId of packages) {
    const label = await fetchTikTokLabel(api, fetch, packageId);
    if (label.kind === 'pending') {
      waiting = label.reason;
      continue;
    }
    const path = `${folder}/tiktok-label-${packageId}.pdf`;
    const up = await db.storage
      .from('shipping-labels')
      .upload(path, label.bytes, { contentType: 'application/pdf', upsert: true });
    if (up.error) throw new Error(`storage: ${up.error.message}`);
    const reg = await db.rpc('attach_marketplace_document', {
      p_order: f.order_id,
      p_kind: 'label',
      p_path: path,
      p_file_name: `etiqueta-tiktok-shop-${packageId}.pdf`,
      p_external_ref: label.ref,
      p_tracking_code: label.tracking ?? null,
      p_source: 'tiktok',
      p_carrier: null,
    });
    if (reg.error) throw new Error(`attach: ${reg.error.message}`);
    attached.push('label');
  }
  return { ok: true, result: ingested.data, status: f.status, attached, waiting };
}

async function webhook(req: Request) {
  const cfg = config();
  // 503: a TikTok Shop tenta de novo depois.
  if (!cfg) return json(503, { error: 'not_configured' });
  const raw = await req.text();
  if (raw.length > 20_000) return json(413, { error: 'too_large' });
  if (!(await verifyTikTokWebhook(cfg.app, raw, req.headers.get('Authorization'))))
    return json(401, { error: 'invalid_signature' });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(200, { ok: true, ignored: 'not_json' });
  }
  const n = parseTikTokWebhook(body);
  if (!n) return json(200, { ok: true, ignored: 'type' });

  const db = service();
  const { data: connectionId } = await db.rpc('marketplace_connection', {
    p_provider: 'tiktok',
    p_account: n.shopId,
  });
  if (!connectionId) return json(200, { ok: true, ignored: 'no_connection' });
  return run(() => processOrder(db, String(connectionId), n.orderId));
}

/** Botão "Buscar etiqueta na TikTok Shop" do pedido (JWT de um membro do vendedor). */
async function documents(req: Request) {
  if (!config()) return json(503, { error: 'not_configured' });
  const authorization = req.headers.get('Authorization');
  if (!authorization) return json(401, { error: 'unauthorized' });
  const input = await readBody(req);
  const orderId = String(input?.order_id ?? '');
  if (!UUID.test(orderId)) return json(400, { error: 'invalid_body' });

  const { data, error } = await callerClient(authorization).rpc('marketplace_documents_request', {
    p_order: orderId,
    p_provider: 'tiktok',
  });
  if (error) {
    if (/jwt/i.test(error.message)) return json(401, { error: 'unauthorized' });
    if (error.message === 'rate_limited') return json(429, { error: 'rate_limited' });
    return json(403, { error: 'forbidden' });
  }
  const row = (data as { connection_id: string; external_id: string }[] | null)?.[0];
  if (!row || !ORDER_ID.test(row.external_id)) return json(404, { error: 'not_marketplace' });
  return run(() => processOrder(service(), row.connection_id, row.external_id));
}

// ---------------------------------------------------------------------
// Publicar (Fase 44)
// ---------------------------------------------------------------------

/** Árvore de categorias por loja (a TikTok Shop libera categorias por loja): 6 horas. */
const categoryCache = new Map<string, { at: number; nodes: Map<string, CategoryNode> }>();

async function categoryTree(api: TikTokClient, connectionId: string) {
  const hit = categoryCache.get(connectionId);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.nodes;
  const nodes = parseTikTokCategories(
    await api.get('/product/202309/categories', { locale: TIKTOK_LOCALE }),
  );
  categoryCache.set(connectionId, { at: Date.now(), nodes });
  return nodes;
}

const attributesOf = async (api: TikTokClient, categoryId: string) =>
  parseTikTokAttributes(
    await api.get(`/product/202309/categories/${categoryId}/attributes`, { locale: TIKTOK_LOCALE }),
  );

/**
 * Consulta de categoria/atributos com a loja de quem chamou: confere o
 * papel e o limite pela RPC e devolve o cliente da loja.
 */
async function lookupApi(
  req: Request,
  input: Record<string, unknown> | null,
): Promise<{ api: TikTokClient; connectionId: string } | Response> {
  if (!config()) return json(503, { error: 'not_configured' });
  const authorization = req.headers.get('Authorization');
  if (!authorization) return json(401, { error: 'unauthorized' });
  const orgId = String(input?.organization_id ?? '');
  if (!UUID.test(orgId)) return json(400, { error: 'invalid_body' });
  const { data, error } = await callerClient(authorization).rpc('marketplace_lookup_connection', {
    p_org: orgId,
    p_provider: 'tiktok',
  });
  if (error) {
    if (/jwt/i.test(error.message)) return json(401, { error: 'unauthorized' });
    if (error.message === 'rate_limited') return json(429, { error: 'rate_limited' });
    if (error.message === 'publish.not_connected') return json(409, { error: error.message });
    return json(403, { error: 'forbidden' });
  }
  const connectionId = String(data);
  return { api: await tiktokShopClient(service(), fetch, connectionId), connectionId };
}

/** Roda a consulta com a loja de quem chamou (erros de permissão respondem antes). */
async function withLookup(
  req: Request,
  input: Record<string, unknown> | null,
  fn: (api: TikTokClient, connectionId: string) => Promise<Record<string, unknown>>,
) {
  let gate: Awaited<ReturnType<typeof lookupApi>>;
  try {
    gate = await lookupApi(req, input);
  } catch (e) {
    return run(() => Promise.reject(e));
  }
  if (gate instanceof Response) return gate;
  const { api, connectionId } = gate;
  return run(() => fn(api, connectionId));
}

/** Sugestão de categoria pelo título (recomendação da TikTok; senão busca na árvore). */
async function categories(req: Request) {
  const input = await readBody(req);
  const q = String(input?.q ?? '').trim();
  if (q.length < 3 || q.length > 120) return json(400, { error: 'invalid_body' });
  return withLookup(req, input, async (api, connectionId) => {
    const suggestions = parseTikTokRecommend(
      await api.post('/product/202309/categories/recommend', { product_title: q }),
    );
    if (suggestions.length) return { suggestions };
    return { suggestions: searchCategories(await categoryTree(api, connectionId), q) };
  });
}

/** Nome, caminho e atributos de uma categoria. */
async function category(req: Request) {
  const input = await readBody(req);
  const id = String(input?.category_id ?? '');
  if (!validTikTokCategory(id)) return json(400, { error: 'invalid_body' });
  return withLookup(req, input, async (api, connectionId) => {
    const nodes = await categoryTree(api, connectionId);
    return {
      category_id: id,
      name: nodes.get(id)?.name ?? id,
      path: categoryPath(nodes, id),
      attributes: await attributesOf(api, id),
    };
  });
}

/**
 * Publica (cria ou atualiza), pausa ou reativa o produto na TikTok Shop.
 * `marketplace_publish_begin` (JWT) confere tudo; o resultado sempre é
 * gravado por `marketplace_publish_finish`, inclusive a falha.
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

  const begun = await beginPublish(callerClient(authorization), productId, 'tiktok', action);
  if (!begun.ok) return json(begun.status, { error: begun.error });
  const data = begun.data;
  const db = service();

  try {
    const { app, accessToken, api } = await tiktokShopSession(db, fetch, data.connection_id);
    const readStatus = async (id: string) =>
      tiktokProductStatus((await api.get(`/product/202309/products/${id}`)).status);

    if (data.action !== 'publish') {
      await api.post(
        `/product/202309/products/${data.action === 'pause' ? 'deactivate' : 'activate'}`,
        { product_ids: [data.external_id] },
      );
      const status = await readStatus(data.external_id!);
      await finishPublish(db, data.run_id, { ok: true, status });
      return json(200, { ok: true, status });
    }

    const attrs = await attributesOf(api, String(data.config.category));
    const warehouse = defaultWarehouse(await api.get('/logistics/202309/warehouses'));
    const existing = data.external_id
      ? tiktokSkuIds(await api.get(`/product/202309/products/${data.external_id}`))
      : new Map<string, string>();
    const uris: string[] = [];
    for (const img of await productImages(db, data.images, TIKTOK_MAX_IMAGES)) {
      uris.push(await uploadTikTokImage(fetch, app, accessToken, img.bytes, img.contentType));
    }

    const built = buildTikTokProduct(data, uris, attrs, warehouse, existing);
    if (!built.ok) {
      await finishPublish(db, data.run_id, { ok: false, error: built.errors.join(' ') });
      return json(422, { error: 'invalid_listing', messages: built.errors });
    }

    let productIdOut = data.external_id;
    let skuIds: Map<string, string>;
    if (productIdOut) {
      skuIds = tiktokSkuIds(
        await api.put(`/product/202309/products/${productIdOut}`, built.item.body),
      );
      if (skuIds.size === 0) {
        skuIds = tiktokSkuIds(await api.get(`/product/202309/products/${productIdOut}`));
      }
    } else {
      const created = await api.post('/product/202309/products', built.item.body);
      productIdOut = String(created.product_id ?? '');
      if (!/^\d{1,30}$/.test(productIdOut))
        throw new StockPushError('TikTok Shop: resposta sem id do produto');
      skuIds = tiktokSkuIds(created);
    }

    const links = built.item.links.map((l) => {
      const skuId = skuIds.get(l.sku);
      return skuId ? { ...l, ref: `${productIdOut}:${skuId}:${warehouse}` } : l;
    });
    const status = await readStatus(productIdOut);
    await finishPublish(db, data.run_id, {
      ok: true,
      externalId: productIdOut,
      status,
      links,
    });
    return json(200, { ok: true, external_id: productIdOut, url: null, status, skipped: [] });
  } catch (e) {
    const message =
      e instanceof StockPushError ? e.message : 'Falha inesperada ao falar com a TikTok Shop.';
    if (!(e instanceof StockPushError))
      console.error('tiktok publish: falha', e instanceof Error ? e.message : '');
    await finishPublish(db, data.run_id, { ok: false, error: message }).catch(() => {});
    return json(502, { error: 'provider_error', message });
  }
}

async function run(fn: () => Promise<Record<string, unknown>>) {
  try {
    return json(200, await fn());
  } catch (e) {
    if (e instanceof NormalizeError) {
      console.error('tiktok: pedido inutilizável', e.message);
      return json(200, { ok: true, ignored: 'unprocessable' });
    }
    if (e instanceof StockPushError) {
      console.error('tiktok: falha', e.message);
      return json(502, { error: 'provider_unavailable', message: e.message });
    }
    console.error('tiktok: falha', e instanceof Error ? e.message : 'erro inesperado');
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
  if (path.endsWith('/webhook')) return webhook(req);
  if (path.endsWith('/documents')) return documents(req);
  if (path.endsWith('/categories')) return categories(req);
  if (path.endsWith('/category')) return category(req);
  if (path.endsWith('/publish')) return publish(req);
  return json(404, { error: 'not_found' });
});
