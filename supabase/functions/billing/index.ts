/**
 * Planos e assinaturas (Fase 42): /functions/v1/billing/...
 *
 *   POST /subscribe  (JWT do proprietário) cria a assinatura no Mercado Pago e
 *                    devolve o link onde o pagador informa o cartão
 *   POST /cancel     (JWT do proprietário) cancela a assinatura vigente
 *   POST /refresh    (JWT de membro) relê no Mercado Pago as assinaturas da
 *                    empresa (volta do pagamento sem esperar a notificação)
 *   POST /webhook    notificações `subscription_preapproval` e
 *                    `subscription_authorized_payment` (assinatura x-signature)
 *
 * Implantada sem verificação de JWT por causa do webhook; as outras rotas
 * chamam o banco com o token de quem pediu (as RPCs conferem o papel).
 *
 * Segredos: MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_WEBHOOK_SECRET e APP_URL.
 * Sem eles: "not_configured" (503). No painel do Mercado Pago, a URL de
 * notificações precisa apontar para /functions/v1/billing/webhook com o
 * tópico "Planos e assinaturas".
 *
 * ATENÇÃO: roda em Deno e não foi executada nos testes do projeto. O corpo
 * da assinatura e a leitura das respostas são testados em
 * `src/integrations/subscriptions.test.ts`; as regras de banco em
 * `src/test/db/plans-billing.test.ts`.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { MP_API, verifyWebhookSignature } from '../_shared/payments/mercadopago.ts';
import {
  SubscriptionShapeError,
  buildPreapprovalBody,
  normalizeAuthorizedPayment,
  normalizePreapproval,
  notificationDataId,
  parseSubscriptionNotification,
} from '../_shared/payments/subscriptions.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 20_000;

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

const service = () =>
  createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const asCaller = (authorization: string) =>
  createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

const config = () => {
  const accessToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN');
  const appUrl = Deno.env.get('APP_URL')?.replace(/\/+$/, '');
  if (!accessToken || !appUrl || !/^https?:\/\//.test(appUrl)) return null;
  return { accessToken, appUrl };
};

const dbErrors: Record<string, [number, string]> = {
  'org.forbidden': [403, 'forbidden'],
  'plans.unavailable': [409, 'unavailable'],
  'plans.already_subscribed': [409, 'already_subscribed'],
  'plans.no_subscription': [409, 'no_subscription'],
  'plans.invalid': [400, 'invalid_body'],
};

function dbError(where: string, error: { message: string }) {
  const mapped = dbErrors[error.message];
  if (mapped) return json(mapped[0], { error: mapped[1] });
  if (/jwt/i.test(error.message)) return json(401, { error: 'unauthorized' });
  console.error(`billing ${where}: ${error.message}`);
  return json(500, { error: 'internal' });
}

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
  method: 'GET' | 'POST' | 'PUT',
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

const cancelAtMp = (accessToken: string, id: string) =>
  mp(accessToken, 'PUT', `/preapproval/${encodeURIComponent(id)}`, { status: 'cancelled' });

/**
 * Relê uma assinatura e aplica no banco. O banco pode pedir para cancelar
 * outras (troca de plano) ou a própria (valor divergente).
 */
async function syncPreapproval(db: SupabaseClient, accessToken: string, id: string) {
  const pre = normalizePreapproval(
    await mp(accessToken, 'GET', `/preapproval/${encodeURIComponent(id)}`),
  );
  const { data, error } = await db.rpc('billing_sync_subscription', { p_data: pre });
  if (error) throw error;
  const result = data as { action: string; cancel: string[] };
  for (const other of result.cancel ?? []) {
    try {
      await cancelAtMp(accessToken, other);
    } catch (e) {
      // A notificação do cancelamento (ou o próximo refresh) tenta de novo.
      console.error('billing: falha ao cancelar assinatura anterior', other, e);
    }
  }
  return { action: result.action, status: pre.status };
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return null;
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------

async function subscribe(req: Request, authorization: string) {
  const cfg = config();
  if (!cfg) return json(503, { error: 'not_configured' });
  const body = await readBody(req);
  const orgId = String(body?.organization_id ?? '');
  const planId = String(body?.plan_id ?? '');
  if (!UUID.test(orgId) || !UUID.test(planId)) return json(400, { error: 'invalid_body' });

  const begun = await asCaller(authorization).rpc('billing_begin_subscription', {
    p_org: orgId,
    p_plan: planId,
  });
  if (begun.error) return dbError('subscribe', begun.error);
  const sub = begun.data as {
    subscription_id: string;
    checkout_url: string | null;
    plan_name?: string;
    price_cents?: number;
    payer_email?: string | null;
    cancel_external_id?: string | null;
  };
  if (sub.checkout_url) return json(200, { checkout_url: sub.checkout_url });

  if (sub.cancel_external_id) {
    // Assinatura em andamento de outro plano: o link antigo deixa de valer.
    await cancelAtMp(cfg.accessToken, sub.cancel_external_id).catch((e) =>
      console.error('billing subscribe: falha ao cancelar a anterior', e),
    );
  }

  let pre;
  try {
    const payload = buildPreapprovalBody({
      subscriptionId: sub.subscription_id,
      planName: sub.plan_name ?? '',
      priceCents: Number(sub.price_cents),
      payerEmail: sub.payer_email ?? '',
      backUrl: `${cfg.appUrl}/plano`,
    });
    pre = normalizePreapproval(
      await mp(cfg.accessToken, 'POST', '/preapproval', payload, sub.subscription_id),
    );
  } catch (e) {
    if (e instanceof SubscriptionShapeError) {
      console.error('billing subscribe: dados inválidos', e.message);
      return json(400, { error: 'invalid_subscription' });
    }
    if (e instanceof MpError && e.status >= 400 && e.status < 500) {
      console.error('billing subscribe: Mercado Pago recusou', e.status, JSON.stringify(e.body));
      return json(402, { error: 'subscription_refused' });
    }
    console.error('billing subscribe: falha', e);
    return json(502, { error: 'provider_unavailable' });
  }
  if (!pre.checkout_url) return json(502, { error: 'provider_unavailable' });

  const attached = await service().rpc('billing_attach_checkout', {
    p_subscription: sub.subscription_id,
    p_external_id: pre.external_id,
    p_checkout_url: pre.checkout_url,
  });
  if (attached.error) return dbError('attach', attached.error);
  return json(200, { checkout_url: pre.checkout_url });
}

async function cancel(req: Request, authorization: string) {
  const cfg = config();
  if (!cfg) return json(503, { error: 'not_configured' });
  const body = await readBody(req);
  const orgId = String(body?.organization_id ?? '');
  if (!UUID.test(orgId)) return json(400, { error: 'invalid_body' });

  const begun = await asCaller(authorization).rpc('billing_cancel_begin', { p_org: orgId });
  if (begun.error) return dbError('cancel', begun.error);
  const externalId = String(begun.data);
  try {
    await cancelAtMp(cfg.accessToken, externalId);
    const result = await syncPreapproval(service(), cfg.accessToken, externalId);
    return json(200, { status: result.status });
  } catch (e) {
    console.error('billing cancel: falha', e);
    if (e instanceof MpError && e.status >= 400 && e.status < 500) {
      return json(409, { error: 'cancel_refused' });
    }
    return json(502, { error: 'provider_unavailable' });
  }
}

async function refresh(req: Request, authorization: string) {
  const cfg = config();
  if (!cfg) return json(503, { error: 'not_configured' });
  const body = await readBody(req);
  const orgId = String(body?.organization_id ?? '');
  if (!UUID.test(orgId)) return json(400, { error: 'invalid_body' });

  const targets = await asCaller(authorization).rpc('billing_refresh_targets', { p_org: orgId });
  if (targets.error) return dbError('refresh', targets.error);
  const db = service();
  let failed = 0;
  for (const id of (targets.data ?? []) as string[]) {
    try {
      await syncPreapproval(db, cfg.accessToken, id);
    } catch (e) {
      failed += 1;
      console.error('billing refresh: falha', id, e);
    }
  }
  return json(200, { ok: true, failed });
}

async function webhook(req: Request) {
  const cfg = config();
  const secret = Deno.env.get('MERCADOPAGO_WEBHOOK_SECRET');
  if (!cfg || !secret) return json(503, { error: 'not_configured' });

  const url = new URL(req.url);
  const body = await readBody(req);
  if (!body) return json(400, { error: 'invalid_body' });
  const dataId = notificationDataId(url.searchParams, body);
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

  const note = parseSubscriptionNotification(url.searchParams, body);
  if (note.kind === 'ignored') return json(200, { ok: true, ignored: 'type' });
  const db = service();
  try {
    if (note.kind === 'preapproval') {
      const result = await syncPreapproval(db, cfg.accessToken, note.id);
      return json(200, { ok: true, result: result.action });
    }
    const payment = normalizeAuthorizedPayment(
      await mp(cfg.accessToken, 'GET', `/authorized_payments/${note.id}`),
    );
    const { data, error } = await db.rpc('billing_record_payment', { p_data: payment });
    if (error) throw error;
    // A cobrança muda a próxima data: relê a assinatura também.
    if (data === 'recorded') await syncPreapproval(db, cfg.accessToken, payment.preapproval_id);
    return json(200, { ok: true, result: data });
  } catch (e) {
    if (e instanceof MpError && e.status === 404)
      return json(200, { ok: true, ignored: 'unknown' });
    if (e instanceof SubscriptionShapeError) {
      console.error('billing webhook: formato inesperado', e.message);
      return json(200, { ok: true, ignored: 'shape' });
    }
    console.error('billing webhook: falha', e);
    return json(502, { error: 'provider_unavailable' });
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  if (path.endsWith('/webhook')) return webhook(req);

  const authorization = req.headers.get('Authorization');
  if (!authorization) return json(401, { error: 'unauthorized' });
  if (path.endsWith('/subscribe')) return subscribe(req, authorization);
  if (path.endsWith('/cancel')) return cancel(req, authorization);
  if (path.endsWith('/refresh')) return refresh(req, authorization);
  return json(404, { error: 'not_found' });
});
