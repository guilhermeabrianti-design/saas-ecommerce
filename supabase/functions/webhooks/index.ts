/**
 * Webhooks de marketplace: POST /functions/v1/webhooks/<provedor>/<id-da-conexão>
 *
 * Fluxo: localizar a conexão → verificar a assinatura HMAC com o segredo
 * guardado (só o service role lê) → normalizar → `ingest_marketplace_order`.
 *
 * Respostas: conexão/segredo desconhecidos e assinatura inválida respondem
 * igual (404/401 sem detalhes); 2xx quando o pedido foi criado, já existia,
 * ficou registrado com erro (o vendedor reprocessa na tela) ou a conexão está
 * pausada; 5xx só em falha de infraestrutura (o provedor tenta de novo).
 *
 * ATENÇÃO: este arquivo roda em Deno e não é executado pelos testes do
 * projeto (não há Deno/Supabase CLI no CI local). A lógica de normalização e
 * de assinatura é testada em `src/integrations/`; o roteamento abaixo deve
 * ser exercitado com `supabase functions serve` antes de ir para produção.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  NormalizeError,
  verifySignature,
  type NormalizeResult,
} from '../_shared/integrations/common.ts';
import {
  SHOPIFY_SIGNATURE_HEADER,
  normalizeShopifyOrder,
} from '../_shared/integrations/shopify.ts';
import {
  WOOCOMMERCE_SIGNATURE_HEADER,
  normalizeWooOrder,
} from '../_shared/integrations/woocommerce.ts';

const MAX_BODY_BYTES = 1_000_000;

const providers = {
  shopify: { header: SHOPIFY_SIGNATURE_HEADER, normalize: normalizeShopifyOrder },
  woocommerce: { header: WOOCOMMERCE_SIGNATURE_HEADER, normalize: normalizeWooOrder },
} as const;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const match = /\/(shopify|woocommerce)\/([0-9a-f-]{36})\/?$/i.exec(new URL(req.url).pathname);
  if (!match) return json(404, { error: 'not_found' });
  const provider = match[1]!.toLowerCase() as keyof typeof providers;
  const connectionId = match[2]!.toLowerCase();

  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return json(413, { error: 'too_large' });
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: 'too_large' });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data: conn, error: connError } = await supabase
    .from('integration_connections')
    .select('id, provider')
    .eq('id', connectionId)
    .maybeSingle();
  if (connError) return json(500, { error: 'lookup_failed' });

  const { data: secretRow, error: secretError } = conn
    ? await supabase
        .from('integration_secrets')
        .select('secret')
        .eq('connection_id', connectionId)
        .maybeSingle()
    : { data: null, error: null };
  if (secretError) return json(500, { error: 'lookup_failed' });

  // Conexão inexistente, de outro provedor ou já desconectada: mesma resposta.
  if (!conn || conn.provider !== provider || !secretRow) return json(404, { error: 'not_found' });

  const { header, normalize } = providers[provider];
  if (!(await verifySignature(secretRow.secret, raw, req.headers.get(header)))) {
    return json(401, { error: 'invalid_signature' });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // WooCommerce envia um ping (`webhook_id=1`, form-encoded) ao salvar o webhook.
    return json(200, { ok: true, ignored: 'not_json' });
  }

  let result: NormalizeResult;
  try {
    result = normalize(payload);
  } catch (e) {
    if (e instanceof NormalizeError) {
      console.error(`webhook ${provider}/${connectionId}: payload inutilizável: ${e.message}`);
      return json(422, { error: 'unprocessable' });
    }
    throw e;
  }
  if (result.kind === 'skip') return json(200, { ok: true, skipped: result.reason });

  const { data: outcome, error } = await supabase.rpc('ingest_marketplace_order', {
    p_connection: connectionId,
    p_external_id: result.externalId,
    p_order: result.order,
  });
  if (error) {
    console.error(`webhook ${provider}/${connectionId}: falha na ingestão: ${error.message}`);
    return json(500, { error: 'ingest_failed' });
  }
  return json(200, { ok: true, result: outcome });
});
