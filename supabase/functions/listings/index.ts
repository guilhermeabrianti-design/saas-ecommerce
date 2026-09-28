/**
 * Publicação de anúncios (Fase 29): POST /functions/v1/listings
 *
 * Corpo: { listing_id, action: 'publish' | 'pause' | 'activate' }
 *
 * Roda com o JWT de quem pediu: `channel_listing_begin` confere o papel
 * (owner/admin), a conexão e o produto e devolve o que enviar. As etapas
 * reais são gravadas conforme acontecem (`channel_listing_step`, service
 * role) — a tela acompanha pela tabela — e `channel_listing_finish` fecha
 * a execução e cria os vínculos de SKU. As credenciais são decifradas só em
 * memória (CREDENTIALS_ENCRYPTION_KEY) e nunca registradas.
 *
 * ATENÇÃO: roda em Deno e não foi executada nos testes do projeto. Os
 * formatos de requisição (em `_shared/integrations/publish.ts`) são testados
 * com respostas simuladas, NÃO contra lojas reais: valide numa loja de
 * desenvolvimento antes de produção.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { decryptCredentials } from '../_shared/integrations/crypto.ts';
import {
  PublishError,
  publishShopify,
  publishWoo,
  setShopifyStatus,
  setWooStatus,
  type PublishPayload,
} from '../_shared/integrations/publish.ts';
import type { ShopifyCredentials, WooCredentials } from '../_shared/integrations/stock.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['publish', 'pause', 'activate']);

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

interface Begin extends PublishPayload {
  run_id: string;
  error?: string;
  action: 'publish' | 'pause' | 'activate';
  connection_id: string;
  provider: 'shopify' | 'woocommerce';
  account: string;
  image_paths: string[];
}

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
  const listingId = String(input.listing_id ?? '');
  const action = String(input.action ?? '');
  if (!UUID.test(listingId) || !ACTIONS.has(action)) return json(400, { error: 'invalid_body' });

  const key = Deno.env.get('CREDENTIALS_ENCRYPTION_KEY');
  if (!key) return json(503, { error: 'not_configured' });

  const asCaller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const service = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const begun = await asCaller.rpc('channel_listing_begin', {
    p_listing: listingId,
    p_action: action,
  });
  if (begun.error) {
    const code = begun.error.message;
    if (code.startsWith('listings.')) return json(409, { error: code });
    if (/jwt/i.test(code)) return json(401, { error: 'unauthorized' });
    console.error('listings begin:', code);
    return json(500, { error: 'internal' });
  }
  const run = begun.data as Begin;
  if (run.error) return json(422, { error: run.error });

  const step = async (name: string, ok: boolean, message: string) => {
    const { error } = await service.rpc('channel_listing_step', {
      p_listing: listingId,
      p_run: run.run_id,
      p_step: name,
      p_status: ok ? 'ok' : 'error',
      p_message: message,
    });
    if (error) console.error('listings step:', error.message);
  };
  const finish = async (
    ok: boolean,
    extra: { externalId?: string; url?: string | null; error?: string },
  ) => {
    const { error } = await service.rpc('channel_listing_finish', {
      p_listing: listingId,
      p_run: run.run_id,
      p_ok: ok,
      p_external_id: extra.externalId ?? null,
      p_external_url: extra.url ?? null,
      p_error: extra.error ?? null,
      p_links:
        ok && run.action === 'publish'
          ? run.variants.map((v) => ({ inventory_item_id: v.inventory_item_id, sku: v.sku }))
          : [],
    });
    if (error) console.error('listings finish:', error.message);
  };

  // Credenciais (decifradas só em memória).
  let secret: Record<string, unknown>;
  let config: Record<string, unknown>;
  {
    const { data, error } = await service
      .from('integration_credentials')
      .select('ciphertext, config')
      .eq('connection_id', run.connection_id)
      .maybeSingle();
    const problem = error
      ? 'Falha ao ler as credenciais.'
      : !data
        ? 'Credenciais de API não configuradas: cadastre em Integrações.'
        : null;
    if (problem || !data) {
      await step('credentials', false, problem!);
      await finish(false, { error: problem! });
      return json(200, { ok: false, error: problem });
    }
    try {
      secret = JSON.parse(await decryptCredentials(key, data.ciphertext, run.connection_id));
      config = (data.config ?? {}) as Record<string, unknown>;
    } catch {
      const message = 'Não foi possível decifrar as credenciais (chave trocada?).';
      await step('credentials', false, message);
      await finish(false, { error: message });
      return json(200, { ok: false, error: message });
    }
    await step('credentials', true, 'Credenciais carregadas.');
  }

  try {
    if (run.action === 'publish') {
      // Fotos: URLs assinadas por 1 hora (o marketplace baixa na hora).
      let imageUrls: string[] = [];
      if (!run.external_id && run.image_paths.length) {
        const signed = await service.storage
          .from('product-images')
          .createSignedUrls(run.image_paths.slice(0, 10), 3600);
        imageUrls = (signed.data ?? []).flatMap((s) => (s.signedUrl ? [s.signedUrl] : []));
      }
      const onStep = (name: 'product' | 'stock', ok: boolean, message: string) =>
        step(name, ok, message);
      const result =
        run.provider === 'shopify'
          ? await publishShopify(fetch, {
              domain: run.account,
              credentials: secret as unknown as ShopifyCredentials,
              locationId: typeof config.location_id === 'string' ? config.location_id : null,
              payload: run,
              imageUrls,
              onStep,
            })
          : await publishWoo(fetch, {
              baseUrl: run.account,
              credentials: secret as unknown as WooCredentials,
              payload: run,
              imageUrls,
              onStep,
            });
      await finish(true, { externalId: result.externalId, url: result.url });
      return json(200, { ok: true, external_id: result.externalId, url: result.url });
    }

    const status = run.action === 'pause' ? 'paused' : 'active';
    if (run.provider === 'shopify') {
      await setShopifyStatus(fetch, {
        domain: run.account,
        credentials: secret as unknown as ShopifyCredentials,
        externalId: run.external_id!,
        status,
      });
    } else {
      await setWooStatus(fetch, {
        baseUrl: run.account,
        credentials: secret as unknown as WooCredentials,
        externalId: run.external_id!,
        status,
      });
    }
    await step(
      'status',
      true,
      status === 'paused' ? 'Pausado no marketplace.' : 'Reativado no marketplace.',
    );
    await finish(true, {});
    return json(200, { ok: true });
  } catch (e) {
    // Só mensagens de PublishError (sem segredos) vão para o banco.
    const message =
      e instanceof PublishError ? e.message : 'Erro inesperado ao falar com o marketplace.';
    if (!(e instanceof PublishError)) console.error('listings: erro inesperado');
    await step(run.action === 'publish' ? 'product' : 'status', false, message);
    await finish(false, { error: message });
    return json(200, { ok: false, error: message });
  }
});
