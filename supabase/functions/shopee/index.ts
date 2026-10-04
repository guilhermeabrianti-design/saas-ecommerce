/**
 * Shopee (Fase 38): /functions/v1/shopee/...
 *
 *   GET  /status     se a Shopee está configurada na plataforma
 *   POST /connect    (JWT) começa a autorização da loja: devolve a URL
 *   GET  /callback   volta da Shopee (?state&code&shop_id): troca o código, cria a conexão
 *   POST /push       notificações assinadas (pedido mudou de status, rastreio) → pedido
 *                    relido na API → ingestão → encaminhamento → envio por postagem → etiqueta
 *   POST /documents  (JWT) relê um pedido e busca a etiqueta (botão do pedido)
 *   POST /categories (JWT) sugere categorias pelo título (Fase 44)
 *   POST /category   (JWT) nome, caminho e atributos de uma categoria (Fase 44)
 *   POST /publish    (JWT) publica/atualiza, pausa ou reativa o anúncio do produto (Fase 44)
 *
 * Implantada sem verificação de JWT (callback e push vêm da Shopee); /connect
 * e /documents conferem o JWT de quem chamou pelas RPCs. O push vale só com
 * a assinatura da partner key, para uma loja conectada, e o pedido é sempre
 * relido com o token dela.
 *
 * Segredos: SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, SHOPEE_ENV (opcional,
 * "test" = sandbox), CREDENTIALS_ENCRYPTION_KEY e APP_URL. Sem eles:
 * "not_configured". No console da Shopee, a URL de push é
 * <SUPABASE_URL>/functions/v1/shopee/push (ou SHOPEE_PUSH_URL, se diferente).
 *
 * ATENÇÃO: roda em Deno e não foi executada nos testes do projeto; a lógica
 * pura está em `_shared/integrations/shopee.ts` (testada). Valide com uma
 * loja de teste da Shopee antes de produção.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { NormalizeError } from '../_shared/integrations/common.ts';
import { encryptCredentials } from '../_shared/integrations/crypto.ts';
import { expiresAt, generateCodeVerifier } from '../_shared/integrations/mercadolivre.ts';
import {
  ORDER_DETAIL_FIELDS,
  ORDER_SN,
  arrangeDropoff,
  authorizationUrl,
  fetchShopeeLabel,
  normalizeShopeeOrder,
  parseShopeePush,
  requestShopeeTokens,
  shopeeClient,
  shopeeItemRefs,
  verifyShopeePush,
  type ShopeeClient,
} from '../_shared/integrations/shopee.ts';
import {
  categoryPath,
  searchCategories,
  suggestionsFromIds,
  type CategoryNode,
} from '../_shared/integrations/publishcommon.ts';
import { beginPublish, finishPublish, productImages } from '../_shared/integrations/publishflow.ts';
import {
  SHOPEE_LANGUAGE,
  SHOPEE_MAX_IMAGES,
  buildShopeeItem,
  modelIds,
  parseShopeeAttributes,
  parseShopeeCategories,
  parseShopeeLogistics,
  parseShopeeRecommend,
  shopeeItemStatus,
  shopeeItemUrl,
  tierVariationBody,
  updateItemBody,
  uploadShopeeImage,
  validShopeeCategory,
} from '../_shared/integrations/shopeepublish.ts';
import { shopeeAccessToken, shopeeAppFromEnv } from '../_shared/integrations/shopeetoken.ts';
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
  const app = shopeeAppFromEnv();
  const key = Deno.env.get('CREDENTIALS_ENCRYPTION_KEY');
  const appUrl = Deno.env.get('APP_URL')?.replace(/\/+$/, '');
  if (!app || !key || !appUrl || !/^https?:\/\//.test(appUrl)) return null;
  const base = `${Deno.env.get('SUPABASE_URL')}/functions/v1/shopee`;
  return {
    app,
    key,
    appUrl,
    callbackUrl: `${base}/callback`,
    pushUrl: Deno.env.get('SHOPEE_PUSH_URL') ?? `${base}/push`,
  };
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

  // A Shopee não usa PKCE: o verifier só cumpre o formato do estado.
  const { data: state, error } = await callerClient(authorization).rpc('oauth_begin', {
    p_org: orgId,
    p_provider: 'shopee',
    p_name: name,
    p_code_verifier: generateCodeVerifier(),
  });
  if (error) {
    if (/forbidden|sellers_only/.test(error.message)) return json(403, { error: 'forbidden' });
    if (/jwt/i.test(error.message)) return json(401, { error: 'unauthorized' });
    return json(400, { error: 'invalid_body' });
  }
  return json(200, {
    url: await authorizationUrl(cfg.app, `${cfg.callbackUrl}?state=${String(state)}`),
  });
}

async function callback(url: URL) {
  const cfg = config();
  if (!cfg) return json(503, { error: 'not_configured' });
  const back = (query: string) => redirect(`${cfg.appUrl}/integracoes?${query}`);
  const code = url.searchParams.get('code') ?? '';
  const shopId = url.searchParams.get('shop_id') ?? '';
  const state = url.searchParams.get('state') ?? '';
  // Autorização pela conta principal (main_account_id) não traz loja: não suportada.
  if (!code || !/^\d{1,20}$/.test(shopId) || !UUID.test(state)) return back('shopee=cancelado');

  const db = service();
  const consumed = await db.rpc('oauth_consume', { p_state: state });
  if (consumed.error) return back('shopee=expirado');
  const s = consumed.data as { organization_id: string; user_id: string; name: string };

  let tokens;
  try {
    tokens = await requestShopeeTokens(fetch, cfg.app, { code, shopId });
  } catch (e) {
    console.error('shopee callback: troca do código falhou', e instanceof Error ? e.message : '');
    return back('shopee=erro');
  }

  const created = await db.rpc('oauth_complete', {
    p_org: s.organization_id,
    p_user: s.user_id,
    p_provider: 'shopee',
    p_name: s.name,
    p_account: shopId,
    p_ciphertext: null,
    p_config: null,
  });
  if (created.error) {
    return back(
      created.error.message === 'integrations.account_in_use'
        ? 'shopee=conta_em_uso'
        : 'shopee=erro',
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
      user_id: shopId,
    },
  });
  if (stored.error) {
    console.error('shopee callback: falha ao guardar credenciais', stored.error.message);
    return back('shopee=erro');
  }
  return redirect(`${cfg.appUrl}/integracoes/${connectionId}?shopee=conectado`);
}

type Db = ReturnType<typeof service>;

interface Forward {
  status: string;
  order_id?: string;
  supplier_order_id: string | null;
  target_order_id: string | null;
  existing: string[];
}

const logEvent = (
  db: Db,
  connectionId: string,
  kind: string,
  externalId: string,
  status: 'ok' | 'error',
  message: string,
) =>
  db
    .from('integration_connections')
    .select('organization_id')
    .eq('id', connectionId)
    .single()
    .then(({ data }) =>
      data
        ? db.from('integration_events').insert({
            organization_id: data.organization_id,
            connection_id: connectionId,
            direction: 'inbound',
            kind,
            external_id: externalId,
            status,
            message: message.slice(0, 500),
          })
        : null,
    );

/**
 * Relê o pedido na Shopee, ingere (duplicado é ok), encaminha ao
 * fornecedor, organiza o envio por postagem (quando a conexão encaminha
 * sozinha e a Shopee não pede mais nada) e anexa a etiqueta.
 */
async function processOrder(
  db: Db,
  connectionId: string,
  shopId: string,
  orderSn: string,
  labelAttempts: number,
) {
  const cfg = config()!;
  const accessToken = await shopeeAccessToken(db, fetch, connectionId, shopId);
  const api = shopeeClient(fetch, cfg.app, { accessToken, shopId });
  const detail = await api.get('/api/v2/order/get_order_detail', {
    order_sn_list: orderSn,
    response_optional_fields: ORDER_DETAIL_FIELDS,
  });
  const order = Array.isArray(detail.order_list) ? detail.order_list[0] : null;
  if (!order) throw new NormalizeError('pedido não encontrado na Shopee');

  const refs = shopeeItemRefs(order);
  if (refs.length) {
    const remembered = await db.rpc('remember_listing_refs', {
      p_connection: connectionId,
      p_refs: refs,
    });
    if (remembered.error) console.error('shopee: referências', remembered.error.message);
  }

  const result = normalizeShopeeOrder(order);
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
  if (f.existing.includes(`label:${orderSn}`)) {
    return { ok: true, result: ingested.data, status: f.status, attached: [] };
  }

  const { data: conn } = await db
    .from('integration_connections')
    .select('auto_forward')
    .eq('id', connectionId)
    .single();
  const orderStatus = String((order as Record<string, unknown>).order_status ?? '');
  if (conn?.auto_forward && orderStatus === 'READY_TO_SHIP') {
    try {
      const arranged = await arrangeDropoff(api, orderSn);
      await logEvent(
        db,
        connectionId,
        arranged ? 'shipment.arranged' : 'shipment.manual',
        orderSn,
        arranged ? 'ok' : 'error',
        arranged
          ? 'Envio organizado na Shopee (postagem pelo fornecedor)'
          : 'A Shopee pede coleta ou dados extras: organize o envio na Shopee para liberar a etiqueta',
      );
    } catch (e) {
      await logEvent(
        db,
        connectionId,
        'shipment.manual',
        orderSn,
        'error',
        `Não foi possível organizar o envio: ${e instanceof StockPushError ? e.message : 'erro inesperado'}. Organize na Shopee.`,
      );
    }
  }

  const label = await fetchShopeeLabel(api, orderSn, { attempts: labelAttempts });
  if (label.kind === 'pending') {
    return {
      ok: true,
      result: ingested.data,
      status: f.status,
      attached: [],
      waiting: label.reason,
    };
  }
  const folder = f.supplier_order_id ? `so-${f.supplier_order_id}` : `o-${f.target_order_id}`;
  const path = `${folder}/shopee-label-${orderSn}.pdf`;
  const up = await db.storage
    .from('shipping-labels')
    .upload(path, label.bytes, { contentType: 'application/pdf', upsert: true });
  if (up.error) throw new Error(`storage: ${up.error.message}`);
  const reg = await db.rpc('attach_marketplace_document', {
    p_order: f.order_id,
    p_kind: 'label',
    p_path: path,
    p_file_name: `etiqueta-shopee-${orderSn}.pdf`,
    p_external_ref: label.ref,
    p_tracking_code: label.tracking ?? null,
    p_source: 'shopee',
    p_carrier: null,
  });
  if (reg.error) throw new Error(`attach: ${reg.error.message}`);
  return { ok: true, result: ingested.data, status: f.status, attached: ['label'] };
}

async function push(req: Request) {
  const cfg = config();
  // 503: a Shopee tenta de novo depois.
  if (!cfg) return json(503, { error: 'not_configured' });
  const raw = await req.text();
  if (raw.length > 20_000) return json(413, { error: 'too_large' });
  if (
    !(await verifyShopeePush(
      cfg.app.partnerKey,
      cfg.pushUrl,
      raw,
      req.headers.get('Authorization'),
    ))
  )
    return json(401, { error: 'invalid_signature' });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(200, { ok: true, ignored: 'not_json' });
  }
  const n = parseShopeePush(body);
  if (!n) return json(200, { ok: true, ignored: 'code' });

  const db = service();
  const { data: connectionId } = await db.rpc('marketplace_connection', {
    p_provider: 'shopee',
    p_account: n.shopId,
  });
  if (!connectionId) return json(200, { ok: true, ignored: 'no_connection' });
  return run(() => processOrder(db, String(connectionId), n.shopId, n.orderSn, 2));
}

/** Botão "Buscar etiqueta na Shopee" do pedido (JWT de um membro do vendedor). */
async function documents(req: Request) {
  if (!config()) return json(503, { error: 'not_configured' });
  const authorization = req.headers.get('Authorization');
  if (!authorization) return json(401, { error: 'unauthorized' });
  const input = await readBody(req);
  const orderId = String(input?.order_id ?? '');
  if (!UUID.test(orderId)) return json(400, { error: 'invalid_body' });

  const { data, error } = await callerClient(authorization).rpc('marketplace_documents_request', {
    p_order: orderId,
    p_provider: 'shopee',
  });
  if (error) {
    if (/jwt/i.test(error.message)) return json(401, { error: 'unauthorized' });
    if (error.message === 'rate_limited') return json(429, { error: 'rate_limited' });
    return json(403, { error: 'forbidden' });
  }
  const row = (
    data as { connection_id: string; external_id: string; external_account_id: string }[] | null
  )?.[0];
  if (!row || !ORDER_SN.test(row.external_id)) return json(404, { error: 'not_marketplace' });
  return run(() =>
    processOrder(service(), row.connection_id, row.external_account_id, row.external_id, 4),
  );
}

// ---------------------------------------------------------------------
// Publicar (Fase 44)
// ---------------------------------------------------------------------

/** Árvore de categorias (igual para todas as lojas do Brasil): 6 horas em memória. */
let categoryCache: { at: number; nodes: Map<string, CategoryNode> } | null = null;

async function categoryTree(api: ShopeeClient) {
  if (categoryCache && Date.now() - categoryCache.at < 6 * 3600_000) return categoryCache.nodes;
  const nodes = parseShopeeCategories(
    await api.get('/api/v2/product/get_category', { language: SHOPEE_LANGUAGE }),
  );
  categoryCache = { at: Date.now(), nodes };
  return nodes;
}

/**
 * Consulta de categoria/atributos com a loja de quem chamou: confere o
 * papel e o limite pela RPC e devolve o cliente da loja.
 */
async function lookupApi(
  req: Request,
  input: Record<string, unknown> | null,
): Promise<{ api: ShopeeClient } | Response> {
  const cfg = config();
  if (!cfg) return json(503, { error: 'not_configured' });
  const authorization = req.headers.get('Authorization');
  if (!authorization) return json(401, { error: 'unauthorized' });
  const orgId = String(input?.organization_id ?? '');
  if (!UUID.test(orgId)) return json(400, { error: 'invalid_body' });
  const { data, error } = await callerClient(authorization).rpc('marketplace_lookup_connection', {
    p_org: orgId,
    p_provider: 'shopee',
  });
  if (error) {
    if (/jwt/i.test(error.message)) return json(401, { error: 'unauthorized' });
    if (error.message === 'rate_limited') return json(429, { error: 'rate_limited' });
    if (error.message === 'publish.not_connected') return json(409, { error: error.message });
    return json(403, { error: 'forbidden' });
  }
  const db = service();
  const connectionId = String(data);
  const { data: conn } = await db
    .from('integration_connections')
    .select('external_account_id')
    .eq('id', connectionId)
    .single();
  if (!conn) return json(409, { error: 'publish.not_connected' });
  const shopId = String(conn.external_account_id);
  const accessToken = await shopeeAccessToken(db, fetch, connectionId, shopId);
  return { api: shopeeClient(fetch, cfg.app, { accessToken, shopId }) };
}

/** Roda a consulta com a loja de quem chamou (erros de permissão respondem antes). */
async function withLookup(
  req: Request,
  input: Record<string, unknown> | null,
  fn: (api: ShopeeClient) => Promise<Record<string, unknown>>,
) {
  let gate: Awaited<ReturnType<typeof lookupApi>>;
  try {
    gate = await lookupApi(req, input);
  } catch (e) {
    return run(() => Promise.reject(e));
  }
  if (gate instanceof Response) return gate;
  const { api } = gate;
  return run(() => fn(api));
}

/** Sugestões de categoria pelo título (recomendação da Shopee; senão busca na árvore). */
async function categories(req: Request) {
  const input = await readBody(req);
  const q = String(input?.q ?? '').trim();
  if (q.length < 3 || q.length > 120) return json(400, { error: 'invalid_body' });
  return withLookup(req, input, async (api) => {
    const nodes = await categoryTree(api);
    const ids = parseShopeeRecommend(
      await api.get('/api/v2/product/category_recommend', { item_name: q }),
    );
    const suggestions = suggestionsFromIds(nodes, ids);
    return { suggestions: suggestions.length ? suggestions : searchCategories(nodes, q) };
  });
}

/** Nome, caminho e atributos de uma categoria. */
async function category(req: Request) {
  const input = await readBody(req);
  const id = String(input?.category_id ?? '');
  if (!validShopeeCategory(id)) return json(400, { error: 'invalid_body' });
  return withLookup(req, input, async (api) => {
    const nodes = await categoryTree(api);
    const attrs = parseShopeeAttributes(
      await api.get('/api/v2/product/get_attributes', {
        category_id: id,
        language: SHOPEE_LANGUAGE,
      }),
    );
    return {
      category_id: id,
      name: nodes.get(id)?.name ?? id,
      path: categoryPath(nodes, id),
      attributes: attrs,
    };
  });
}

/**
 * Publica (cria ou atualiza), pausa ou reativa o anúncio do produto na
 * Shopee. `marketplace_publish_begin` (JWT) confere tudo; o resultado
 * sempre é gravado por `marketplace_publish_finish`, inclusive a falha.
 */
async function publish(req: Request) {
  const cfg = config();
  if (!cfg) return json(503, { error: 'not_configured' });
  const authorization = req.headers.get('Authorization');
  if (!authorization) return json(401, { error: 'unauthorized' });
  const input = await readBody(req);
  const productId = String(input?.product_id ?? '');
  const action = String(input?.action ?? '');
  if (!UUID.test(productId) || !['publish', 'pause', 'activate'].includes(action))
    return json(400, { error: 'invalid_body' });

  const begun = await beginPublish(callerClient(authorization), productId, 'shopee', action);
  if (!begun.ok) return json(begun.status, { error: begun.error });
  const data = begun.data;
  const db = service();
  const shopId = String(data.account_id ?? '');

  try {
    const accessToken = await shopeeAccessToken(db, fetch, data.connection_id, shopId);
    const api = shopeeClient(fetch, cfg.app, { accessToken, shopId });
    const readStatus = async (itemId: string) => {
      const info = await api.get('/api/v2/product/get_item_base_info', { item_id_list: itemId });
      const list = Array.isArray(info.item_list)
        ? (info.item_list as Record<string, unknown>[])
        : [];
      return shopeeItemStatus(list[0]?.item_status);
    };

    if (data.action !== 'publish') {
      await api.post('/api/v2/product/unlist_item', {
        item_list: [{ item_id: Number(data.external_id), unlist: data.action === 'pause' }],
      });
      const status = await readStatus(data.external_id!);
      await finishPublish(db, data.run_id, { ok: true, status });
      return json(200, { ok: true, status });
    }

    const categoryId = String(data.config.category);
    const attrs = parseShopeeAttributes(
      await api.get('/api/v2/product/get_attributes', {
        category_id: categoryId,
        language: SHOPEE_LANGUAGE,
      }),
    );
    const logistics = parseShopeeLogistics(await api.get('/api/v2/logistics/get_channel_list'));
    const imageIds: string[] = [];
    for (const img of await productImages(db, data.images, SHOPEE_MAX_IMAGES)) {
      imageIds.push(await uploadShopeeImage(fetch, cfg.app, img.bytes, img.contentType));
    }

    const built = buildShopeeItem(data, imageIds, attrs, logistics);
    if (!built.ok) {
      await finishPublish(db, data.run_id, { ok: false, error: built.errors.join(' ') });
      return json(422, { error: 'invalid_listing', messages: built.errors });
    }
    const item = built.item;
    let itemId = data.external_id;
    const skipped: string[] = [];
    const links: { inventory_item_id: string; sku: string; ref: string }[] = [];

    if (itemId) {
      await api.post('/api/v2/product/update_item', updateItemBody(itemId, item));
      if (item.tiers) {
        const ids = modelIds(await api.get('/api/v2/product/get_model_list', { item_id: itemId }));
        const known = item.models.filter((m) => ids.has(m.sku));
        skipped.push(...item.models.filter((m) => !ids.has(m.sku)).map((m) => m.sku));
        if (known.length) {
          await api.post('/api/v2/product/update_price', {
            item_id: Number(itemId),
            price_list: known.map((m) => ({
              model_id: Number(ids.get(m.sku)),
              original_price: item.price,
            })),
          });
          await api.post('/api/v2/product/update_stock', {
            item_id: Number(itemId),
            stock_list: known.map((m) => ({
              model_id: Number(ids.get(m.sku)),
              seller_stock: [{ stock: m.stock }],
            })),
          });
        }
        for (const m of known) {
          links.push({
            inventory_item_id: m.inventory_item_id,
            sku: m.sku,
            ref: `${itemId}:${ids.get(m.sku)}`,
          });
        }
      } else {
        await api.post('/api/v2/product/update_price', {
          item_id: Number(itemId),
          price_list: [{ model_id: 0, original_price: item.price }],
        });
        await api.post('/api/v2/product/update_stock', {
          item_id: Number(itemId),
          stock_list: [{ model_id: 0, seller_stock: [{ stock: item.single!.stock }] }],
        });
      }
    } else {
      const created = await api.post('/api/v2/product/add_item', item.body);
      itemId = String(created.item_id ?? '');
      if (!/^\d{1,20}$/.test(itemId))
        throw new StockPushError('Shopee: resposta sem id do anúncio');
      if (item.tiers) {
        await api.post('/api/v2/product/init_tier_variation', tierVariationBody(itemId, item));
        const ids = modelIds(await api.get('/api/v2/product/get_model_list', { item_id: itemId }));
        for (const m of item.models) {
          const modelId = ids.get(m.sku);
          if (modelId) {
            links.push({
              inventory_item_id: m.inventory_item_id,
              sku: m.sku,
              ref: `${itemId}:${modelId}`,
            });
          }
        }
      }
    }
    if (item.single?.inventory_item_id) {
      links.push({
        inventory_item_id: item.single.inventory_item_id,
        sku: item.single.sku,
        ref: `${itemId}:0`,
      });
    }

    const status = await readStatus(itemId);
    const url = shopeeItemUrl(shopId, itemId);
    await finishPublish(db, data.run_id, { ok: true, externalId: itemId, url, status, links });
    return json(200, { ok: true, external_id: itemId, url, status, skipped });
  } catch (e) {
    const message =
      e instanceof StockPushError ? e.message : 'Falha inesperada ao falar com a Shopee.';
    if (!(e instanceof StockPushError))
      console.error('shopee publish: falha', e instanceof Error ? e.message : '');
    await finishPublish(db, data.run_id, { ok: false, error: message }).catch(() => {});
    return json(502, { error: 'provider_error', message });
  }
}

async function run(fn: () => Promise<Record<string, unknown>>) {
  try {
    return json(200, await fn());
  } catch (e) {
    if (e instanceof NormalizeError) {
      console.error('shopee: pedido inutilizável', e.message);
      return json(200, { ok: true, ignored: 'unprocessable' });
    }
    if (e instanceof StockPushError) {
      console.error('shopee: falha', e.message);
      return json(502, { error: 'provider_unavailable', message: e.message });
    }
    console.error('shopee: falha', e instanceof Error ? e.message : 'erro inesperado');
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
  if (path.endsWith('/push')) return push(req);
  if (path.endsWith('/documents')) return documents(req);
  if (path.endsWith('/categories')) return categories(req);
  if (path.endsWith('/category')) return category(req);
  if (path.endsWith('/publish')) return publish(req);
  return json(404, { error: 'not_found' });
});
