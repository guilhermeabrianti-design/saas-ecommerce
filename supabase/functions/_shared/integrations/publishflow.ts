import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { PublishData } from './mlpublish.ts';
import { StockPushError } from './stock.ts';

/**
 * Fluxo comum de publicação na Shopee e na TikTok Shop (Deno, Fase 44):
 * começar pela RPC com o JWT de quem chamou, baixar as fotos do produto e
 * gravar o resultado (sucesso ou falha) pela RPC do service role.
 */

const beginErrors: Record<string, number> = {
  'products.not_found': 404,
  'channels.sellers_only': 403,
  rate_limited: 429,
  'publish.busy': 409,
};

export type Begin = { ok: true; data: PublishData } | { ok: false; status: number; error: string };

export async function beginPublish(
  caller: SupabaseClient,
  productId: string,
  provider: 'shopee' | 'tiktok',
  action: string,
): Promise<Begin> {
  const { data, error } = await caller.rpc('marketplace_publish_begin', {
    p_product: productId,
    p_provider: provider,
    p_action: action,
  });
  if (error) {
    if (/jwt/i.test(error.message)) return { ok: false, status: 401, error: 'unauthorized' };
    return { ok: false, status: beginErrors[error.message] ?? 422, error: error.message };
  }
  return { ok: true, data: data as PublishData };
}

export interface FinishArgs {
  ok: boolean;
  externalId?: string | null;
  url?: string | null;
  status?: string | null;
  error?: string | null;
  links?: { inventory_item_id: string; sku: string; ref?: string }[];
}

export async function finishPublish(service: SupabaseClient, runId: string, args: FinishArgs) {
  const { error } = await service.rpc('marketplace_publish_finish', {
    p_run: runId,
    p_ok: args.ok,
    p_external_id: args.externalId ?? null,
    p_external_url: args.url ?? null,
    p_status: args.status ?? null,
    p_error: args.error ?? null,
    p_links: args.links ?? [],
  });
  if (error) throw new Error(`finish: ${error.message}`);
}

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Baixa as fotos do produto (bucket privado) para enviar ao marketplace. */
export async function productImages(
  service: SupabaseClient,
  paths: string[],
  max: number,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }[]> {
  const out: { bytes: Uint8Array<ArrayBuffer>; contentType: string }[] = [];
  for (const path of paths.slice(0, max)) {
    const { data, error } = await service.storage.from('product-images').download(path);
    if (error || !data) throw new StockPushError('Não foi possível ler uma foto do produto.');
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.length === 0 || bytes.length > IMAGE_MAX_BYTES) continue;
    out.push({ bytes, contentType: data.type || 'image/jpeg' });
  }
  return out;
}
