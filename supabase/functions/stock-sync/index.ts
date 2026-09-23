/**
 * Worker de estoque: POST /functions/v1/stock-sync (chamado por agendador).
 *
 * Autenticação: cabeçalho `x-sync-secret` = segredo STOCK_SYNC_SECRET (função
 * implantada com --no-verify-jwt; sem o segredo, 401). Usa o service role para
 * `claim_stock_sync` / `complete_stock_sync` e para ler o texto cifrado das
 * credenciais, que é decifrado só em memória.
 *
 * Fluxo: reivindica lotes de 5 → decifra as credenciais (uma vez por conexão) →
 * envia o disponível ao marketplace em paralelo → conclui ou registra a falha
 * (backoff e desistência após 5 tentativas são do banco). Para em 90 s.
 *
 * Agendamento (pg_cron + pg_net, a cada minuto) — ver DATABASE.md.
 *
 * ATENÇÃO: roda em Deno e não foi executada nos testes do projeto; as chamadas
 * às APIs (Shopify/WooCommerce) não foram exercitadas contra lojas reais.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { decryptCredentials, timingSafeEqualText } from '../_shared/integrations/crypto.ts';
import {
  StockPushError,
  pushShopifyStock,
  pushWooStock,
  type ShopifyCredentials,
  type WooCredentials,
} from '../_shared/integrations/stock.ts';

const BATCH = 5;
const DEADLINE_MS = 90_000;

interface Claimed {
  id: string;
  connection_id: string;
  provider: string;
  external_account_id: string;
  external_id: string;
  available: number;
}

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const expected = Deno.env.get('STOCK_SYNC_SECRET');
  const key = Deno.env.get('CREDENTIALS_ENCRYPTION_KEY');
  if (!expected || !key) {
    console.error('stock-sync: STOCK_SYNC_SECRET/CREDENTIALS_ENCRYPTION_KEY não configurados');
    return json(503, { error: 'not_configured' });
  }
  if (!timingSafeEqualText(req.headers.get('x-sync-secret') ?? '', expected)) {
    return json(401, { error: 'unauthorized' });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  type Loaded = { secret: Record<string, unknown>; config: Record<string, unknown> } | Error;
  const cache = new Map<string, Promise<Loaded>>();
  const load = (connectionId: string): Promise<Loaded> => {
    let entry = cache.get(connectionId);
    if (!entry) {
      entry = (async (): Promise<Loaded> => {
        const { data, error } = await supabase
          .from('integration_credentials')
          .select('ciphertext, config')
          .eq('connection_id', connectionId)
          .maybeSingle();
        if (error) return new Error('falha ao ler as credenciais');
        if (!data) return new Error('credenciais de API não configuradas');
        try {
          const secret = JSON.parse(await decryptCredentials(key, data.ciphertext, connectionId));
          return { secret, config: data.config ?? {} };
        } catch {
          return new Error('não foi possível decifrar as credenciais (chave trocada?)');
        }
      })();
      cache.set(connectionId, entry);
    }
    return entry;
  };

  const push = async (row: Claimed): Promise<void> => {
    const creds = await load(row.connection_id);
    if (creds instanceof Error) throw new StockPushError(creds.message);
    if (row.provider === 'shopify') {
      await pushShopifyStock(fetch, {
        domain: row.external_account_id,
        credentials: creds.secret as unknown as ShopifyCredentials,
        locationId: String(creds.config.location_id ?? ''),
        sku: row.external_id,
        available: row.available,
      });
    } else if (row.provider === 'woocommerce') {
      await pushWooStock(fetch, {
        baseUrl: row.external_account_id,
        credentials: creds.secret as unknown as WooCredentials,
        sku: row.external_id,
        available: row.available,
      });
    } else {
      throw new StockPushError('marketplace sem suporte a envio de estoque');
    }
  };

  const started = Date.now();
  let done = 0;
  let failed = 0;

  while (Date.now() - started < DEADLINE_MS) {
    const { data, error } = await supabase.rpc('claim_stock_sync', { p_limit: BATCH });
    if (error) {
      console.error('stock-sync: falha ao reivindicar', error.message);
      return json(500, { error: 'claim_failed', done, failed });
    }
    const rows = (data ?? []) as Claimed[];
    if (rows.length === 0) break;

    await Promise.all(
      rows.map(async (row) => {
        let message: string | null = null;
        try {
          await push(row);
        } catch (e) {
          // Só mensagens de StockPushError (sem segredos) vão para o banco.
          message = e instanceof StockPushError ? e.message : 'erro inesperado ao enviar estoque';
          if (!(e instanceof StockPushError)) console.error('stock-sync: erro inesperado');
        }
        const { error: completeError } = await supabase.rpc('complete_stock_sync', {
          p_id: row.id,
          p_error: message,
        });
        if (completeError) console.error('stock-sync: falha ao concluir', completeError.message);
        if (message === null) done++;
        else failed++;
      }),
    );
  }
  return json(200, { ok: true, done, failed });
});
