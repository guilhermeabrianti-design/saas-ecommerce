/**
 * Checkout próprio (Fase 21): /functions/v1/checkout/...
 *
 *   GET  /offer/<produto>  oferta pública + chave pública do Mercado Pago
 *   POST /pay              cria o pedido e o pagamento (PIX, cartão ou boleto)
 *   POST /webhook          notificação do Mercado Pago (assinatura x-signature)
 *   POST /refund           estorno pedido pela equipe (JWT de admin)
 *
 * Implantada sem verificação de JWT (o comprador não tem conta): /pay e
 * /offer só usam RPCs do service role que validam tudo no banco; /webhook
 * confere a assinatura e relê o pagamento na API; /refund exige o JWT de um
 * admin (checado pela RPC com o token de quem chamou).
 *
 * Segredos: MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_PUBLIC_KEY,
 * MERCADOPAGO_WEBHOOK_SECRET. Sem eles: "not_configured" (503).
 *
 * ATENÇÃO: roda em Deno e não foi executada nos testes do projeto. Validação,
 * corpo do pagamento, normalização da resposta e assinatura são testados em
 * `src/integrations/mercadopago.test.ts`; as regras de banco em
 * `src/test/db/checkout.test.ts`. Teste com as credenciais de teste do
 * Mercado Pago antes de usar credenciais de produção.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import {
  CheckoutInputError,
  MP_API,
  PaymentShapeError,
  buildPaymentBody,
  normalizePayment,
  parseCheckoutRequest,
  verifyWebhookSignature,
  type NormalizedPayment,
} from '../_shared/payments/mercadopago.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 20_000;

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

const service = () =>
  createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const mpConfig = () => {
  const accessToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN');
  const publicKey = Deno.env.get('MERCADOPAGO_PUBLIC_KEY');
  return accessToken && publicKey ? { accessToken, publicKey } : null;
};

/** Erros de regra do banco → status e código estável para a tela. */
const dbErrors: Record<string, [number, string]> = {
  'checkout.invalid': [400, 'invalid_body'],
  'checkout.unavailable': [409, 'unavailable'],
  'checkout.price_below_cost': [409, 'unavailable'],
  'fees.commission_not_configured': [409, 'unavailable'],
  'orders.source_unavailable': [409, 'unavailable'],
  'orders.item_unavailable': [409, 'unavailable'],
  'orders.insufficient_stock': [409, 'out_of_stock'],
  'checkout.rate_limited': [429, 'rate_limited'],
  'admin.forbidden': [403, 'forbidden'],
  'checkout.not_found': [404, 'not_found'],
  'checkout.not_refundable': [409, 'not_refundable'],
  'checkout.already_shipped': [409, 'already_shipped'],
};

function dbError(where: string, error: { message: string; code?: string }) {
  const mapped = dbErrors[error.message];
  if (mapped) return json(mapped[0], { error: mapped[1] });
  // Violação de CHECK: dado do comprador que o banco recusou.
  if (error.code === '23514') return json(400, { error: 'invalid_buyer' });
  if (/jwt/i.test(error.message)) return json(401, { error: 'unauthorized' });
  console.error(`checkout ${where}: ${error.message}`);
  return json(500, { error: 'internal' });
}

// ---------------------------------------------------------------------
// Mercado Pago
// ---------------------------------------------------------------------

class MpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`mercadopago ${status}`);
  }
}

async function mp(
  accessToken: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<unknown> {
  const res = await fetch(`${MP_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new MpError(res.status, data);
  return data;
}

const fetchPayment = async (accessToken: string, id: string) =>
  normalizePayment(await mp(accessToken, 'GET', `/v1/payments/${id}`));

/** Estorno total (idempotente por pagamento). */
const refundPayment = (accessToken: string, id: string) =>
  mp(accessToken, 'POST', `/v1/payments/${id}/refunds`, {}, `refund-${id}`);

/**
 * Aplica o estado no banco; se o banco pedir estorno (sem estoque, valor
 * divergente…), estorna e aplica de novo.
 */
async function syncPayment(
  db: SupabaseClient,
  accessToken: string,
  payment: NormalizedPayment,
): Promise<{ action: string; payment: NormalizedPayment }> {
  const { data, error } = await db.rpc('checkout_sync_payment', { p_payment: payment });
  if (error) throw error;
  if (data !== 'refund_required') return { action: String(data), payment };

  await refundPayment(accessToken, payment.external_id);
  const refreshed = await fetchPayment(accessToken, payment.external_id);
  const again = await db.rpc('checkout_sync_payment', { p_payment: refreshed });
  if (again.error) throw again.error;
  return { action: String(again.data), payment: refreshed };
}

// ---------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------

async function offer(productId: string) {
  if (!UUID.test(productId)) return json(404, { error: 'not_found' });
  const db = service();
  const { data, error } = await db.rpc('checkout_offer', { p_product: productId });
  if (error) return dbError('offer', error);
  if (!data) return json(404, { error: 'not_found' });

  const paths = (data.image_paths ?? []) as string[];
  let images: string[] = [];
  if (paths.length) {
    const signed = await db.storage.from('product-images').createSignedUrls(paths, 3600);
    images = (signed.data ?? []).flatMap((s) => (s.signedUrl ? [s.signedUrl] : []));
  }
  const { image_paths: _paths, ...rest } = data as Record<string, unknown>;
  const config = mpConfig();
  return json(200, {
    offer: { ...rest, images },
    payments: config ? { configured: true, public_key: config.publicKey } : { configured: false },
  });
}

async function pay(req: Request) {
  const config = mpConfig();
  if (!config) return json(503, { error: 'not_configured' });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: 'too_large' });
  let input;
  try {
    input = parseCheckoutRequest(JSON.parse(raw));
  } catch (e) {
    if (e instanceof CheckoutInputError || e instanceof SyntaxError) {
      return json(400, {
        error: 'invalid_body',
        field: e instanceof CheckoutInputError ? e.message : null,
      });
    }
    throw e;
  }

  const db = service();
  const created = await db.rpc('checkout_create_order', {
    p_product: input.product_id,
    p_variant: input.variant_id,
    p_quantity: input.quantity,
    p_customer: input.buyer,
    p_request_id: input.request_id,
  });
  if (created.error) return dbError('create', created.error);
  const order = created.data as {
    order_id: string;
    order_number: number;
    total_cents: number;
    token: string;
    external_id: string | null;
    description: string;
  };

  let payment: NormalizedPayment;
  try {
    if (order.external_id) {
      // Mesma tentativa repetida (ex.: a resposta anterior se perdeu).
      payment = await fetchPayment(config.accessToken, order.external_id);
    } else {
      const notificationUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/checkout/webhook`;
      const body = buildPaymentBody(input, { ...order }, notificationUrl);
      payment = normalizePayment(
        await mp(config.accessToken, 'POST', '/v1/payments', body, order.order_id),
      );
    }
  } catch (e) {
    if (e instanceof MpError && e.status >= 400 && e.status < 500) {
      // Recusado na criação (token do cartão inválido, dados do pagador…).
      console.error('checkout pay: Mercado Pago recusou', e.status, JSON.stringify(e.body));
      const abandon = await db.rpc('checkout_abandon', { p_order: order.order_id });
      if (abandon.error) console.error('checkout pay: abandon', abandon.error.message);
      return json(402, { error: 'payment_refused' });
    }
    console.error('checkout pay: falha ao criar pagamento', e);
    // O pedido fica pendente; repetir com o mesmo request_id retoma.
    return json(502, { error: 'provider_unavailable' });
  }

  try {
    const result = await syncPayment(db, config.accessToken, payment);
    return json(200, {
      token: order.token,
      order_number: order.order_number,
      status: result.payment.status,
      status_detail: result.payment.status_detail,
      method: result.payment.method,
    });
  } catch (e) {
    console.error('checkout pay: falha ao registrar', e);
    // O pagamento existe no Mercado Pago; a notificação completa o registro.
    return json(200, { token: order.token, order_number: order.order_number, status: 'pending' });
  }
}

async function webhook(req: Request) {
  const config = mpConfig();
  const secret = Deno.env.get('MERCADOPAGO_WEBHOOK_SECRET');
  // 503: o Mercado Pago tenta de novo depois que a configuração existir.
  if (!config || !secret) return json(503, { error: 'not_configured' });

  const url = new URL(req.url);
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: 'too_large' });
  let body: Record<string, unknown> = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return json(400, { error: 'invalid_body' });
  }
  const type = url.searchParams.get('type') ?? url.searchParams.get('topic') ?? body.type;
  const dataId =
    url.searchParams.get('data.id') ??
    url.searchParams.get('id') ??
    String((body.data as Record<string, unknown> | undefined)?.id ?? '');

  if (
    !(await verifyWebhookSignature(
      secret,
      req.headers.get('x-signature'),
      req.headers.get('x-request-id'),
      dataId || null,
    ))
  ) {
    return json(401, { error: 'invalid_signature' });
  }
  if (type !== 'payment') return json(200, { ok: true, ignored: 'type' });
  if (!/^[0-9]{1,30}$/.test(dataId)) return json(200, { ok: true, ignored: 'id' });

  let payment: NormalizedPayment;
  try {
    payment = await fetchPayment(config.accessToken, dataId);
  } catch (e) {
    if (e instanceof MpError && e.status === 404)
      return json(200, { ok: true, ignored: 'unknown' });
    if (e instanceof PaymentShapeError) {
      console.error('checkout webhook: pagamento com formato inesperado', e.message);
      return json(200, { ok: true, ignored: 'shape' });
    }
    console.error('checkout webhook: falha ao consultar', e);
    return json(502, { error: 'provider_unavailable' });
  }
  // Pagamento que não nasceu no checkout (ex.: notificação de teste).
  if (!payment.external_reference) return json(200, { ok: true, ignored: 'reference' });

  try {
    const result = await syncPayment(service(), config.accessToken, payment);
    return json(200, { ok: true, result: result.action });
  } catch (e) {
    const message = (e as { message?: string }).message ?? '';
    // Notificação antes do registro do pagamento: pede nova tentativa.
    if (message === 'checkout.payment_not_found') return json(409, { error: 'not_ready' });
    console.error('checkout webhook: falha ao aplicar', e);
    return json(500, { error: 'internal' });
  }
}

async function refund(req: Request) {
  const config = mpConfig();
  if (!config) return json(503, { error: 'not_configured' });
  const authorization = req.headers.get('Authorization');
  if (!authorization) return json(401, { error: 'unauthorized' });
  let input: { order_id?: unknown };
  try {
    input = await req.json();
  } catch {
    return json(400, { error: 'invalid_body' });
  }
  const orderId = String(input.order_id ?? '');
  if (!UUID.test(orderId)) return json(400, { error: 'invalid_body' });

  // Autorização e auditoria com o JWT de quem pediu.
  const asCaller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const begin = await asCaller.rpc('admin_checkout_refund_begin', { p_order: orderId });
  if (begin.error) return dbError('refund', begin.error);
  const externalId = String(begin.data);

  try {
    await refundPayment(config.accessToken, externalId);
    const payment = await fetchPayment(config.accessToken, externalId);
    const result = await syncPayment(service(), config.accessToken, payment);
    return json(200, { status: result.payment.status, result: result.action });
  } catch (e) {
    console.error('checkout refund: falha', e);
    if (e instanceof MpError && e.status >= 400 && e.status < 500) {
      return json(409, { error: 'refund_refused' });
    }
    return json(502, { error: 'provider_unavailable' });
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const path = new URL(req.url).pathname.replace(/\/+$/, '');

  const offerMatch = /\/offer\/([^/]+)$/.exec(path);
  if (offerMatch && req.method === 'GET') return offer(offerMatch[1]!.toLowerCase());
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (path.endsWith('/pay')) return pay(req);
  if (path.endsWith('/webhook')) return webhook(req);
  if (path.endsWith('/refund')) return refund(req);
  return json(404, { error: 'not_found' });
});
