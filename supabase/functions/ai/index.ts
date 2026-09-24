/**
 * IA: POST /functions/v1/ai
 *
 * Descrição de produto (Fase 13):
 *   { "organization_id": "<uuid>", "product_id": "<uuid>" } → { description, remaining }
 * Geradores das Ferramentas (Fase 20):
 *   { ..., "kind": "title" | "ad_copy" | "video_script" | "live_script", "brief"?: "<até 300>" }
 *   → { items: string[], remaining }
 *
 * Tudo roda com o JWT de quem chamou (sem service role): o banco decide quem
 * pode e aplica a cota (`ai_begin_description` / `ai_begin_generation`), a
 * função só chama o modelo e fecha a reserva (`ai_finish`, que devolve a cota
 * em caso de falha). O texto NÃO é salvo: volta como sugestão para revisão.
 *
 * Segredos (Supabase Secrets): ANTHROPIC_API_KEY (obrigatório), AI_MODEL
 * (opcional; padrão claude-opus-5). SUPABASE_URL/SUPABASE_ANON_KEY já existem.
 *
 * ATENÇÃO: roda em Deno e não foi executada nos testes do projeto (sem Deno,
 * Supabase CLI nem chave de API neste ambiente). Prompts, esquema e limpeza
 * das respostas são testados em `src/features/ai/` e `src/features/tools/`;
 * exercite com `supabase functions serve ai` antes de produção.
 */
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import {
  DEFAULT_MODEL,
  buildDescriptionPrompt,
  cleanDescription,
  supportsEffort,
} from '../_shared/ai/description.ts';
import {
  GENERATION_KINDS,
  GENERATION_SCHEMA,
  buildGenerationPrompt,
  cleanItems,
  parseGeneration,
  type GenerationKind,
} from '../_shared/ai/generation.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Erros de regra do banco → status HTTP e código estável para o app. */
const dbErrors: Record<string, [number, string]> = {
  'org.forbidden': [403, 'forbidden'],
  'ai.product_not_found': [404, 'product_not_found'],
  'ai.quota_exceeded': [429, 'quota_exceeded'],
  'ai.invalid': [400, 'invalid_body'],
};

function beginErrorResponse(error: { message: string }) {
  const mapped = dbErrors[error.message];
  if (mapped) return json(mapped[0], { error: mapped[1] });
  // JWT inválido/expirado chega aqui como erro do PostgREST.
  if (/jwt/i.test(error.message)) return json(401, { error: 'unauthorized' });
  console.error('ai: falha ao reservar', error.message);
  return json(500, { error: 'begin_failed' });
}

function finisher(supabase: SupabaseClient, usageId: string) {
  return async (ok: boolean, inputTokens = 0, outputTokens = 0) => {
    const { error } = await supabase.rpc('ai_finish', {
      p_usage: usageId,
      p_ok: ok,
      p_input_tokens: inputTokens,
      p_output_tokens: outputTokens,
    });
    if (error) console.error('ai: falha ao fechar a reserva', error.message);
  };
}

const textOf = (content: Array<{ type: string; text?: string }>) =>
  content.flatMap((block) => (block.type === 'text' && block.text ? [block.text] : [])).join('\n');

function modelFailure(e: unknown) {
  if (e instanceof Anthropic.RateLimitError) return json(503, { error: 'ai_busy' });
  console.error('ai: falha ao chamar o modelo', e instanceof Error ? e.message : 'desconhecida');
  return json(502, { error: 'model_failed' });
}

async function describe(
  supabase: SupabaseClient,
  apiKey: string,
  orgId: string,
  productId: string,
) {
  const { data: begin, error: beginError } = await supabase.rpc('ai_begin_description', {
    p_org: orgId,
    p_product: productId,
  });
  if (beginError) return beginErrorResponse(beginError);
  const finish = finisher(supabase, begin.usage_id);

  try {
    const model = Deno.env.get('AI_MODEL') || DEFAULT_MODEL;
    const { system, user } = buildDescriptionPrompt(begin.product);
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }],
      ...(supportsEffort(model) ? { output_config: { effort: 'low' as const } } : {}),
    });

    if (message.stop_reason === 'refusal') {
      await finish(false);
      return json(422, { error: 'refused' });
    }
    const description = cleanDescription(textOf(message.content));
    if (!description) {
      await finish(false);
      return json(502, { error: 'empty_response' });
    }

    await finish(true, message.usage.input_tokens, message.usage.output_tokens);
    return json(200, { description, remaining: begin.remaining });
  } catch (e) {
    await finish(false);
    return modelFailure(e);
  }
}

async function generate(
  supabase: SupabaseClient,
  apiKey: string,
  orgId: string,
  productId: string,
  kind: GenerationKind,
  brief: string | null,
) {
  const { data: begin, error: beginError } = await supabase.rpc('ai_begin_generation', {
    p_org: orgId,
    p_product: productId,
    p_kind: kind,
    p_brief: brief,
  });
  if (beginError) return beginErrorResponse(beginError);
  const finish = finisher(supabase, begin.usage_id);

  try {
    const model = Deno.env.get('AI_MODEL') || DEFAULT_MODEL;
    const { system, user } = buildGenerationPrompt(kind, begin.product, begin.brief);
    const client = new Anthropic({ apiKey });
    // Fallback no servidor: se o modelo principal recusar por política, a API
    // tenta de novo no modelo de reserva dentro da mesma chamada.
    const message = await client.beta.messages.create({
      model,
      max_tokens: 8192,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages: [{ role: 'user', content: user }],
      output_config: {
        format: { type: 'json_schema', schema: GENERATION_SCHEMA },
        ...(supportsEffort(model) ? { effort: 'low' as const } : {}),
      },
    });

    // Recusa de toda a cadeia (principal e reserva).
    if (message.stop_reason === 'refusal') {
      await finish(false);
      return json(422, { error: 'refused' });
    }
    const items = cleanItems(kind, parseGeneration(textOf(message.content)));
    if (items.length === 0) {
      await finish(false);
      return json(502, { error: 'empty_response' });
    }

    await finish(true, message.usage.input_tokens, message.usage.output_tokens);
    return json(200, { items, remaining: begin.remaining });
  } catch (e) {
    await finish(false);
    return modelFailure(e);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const authorization = req.headers.get('Authorization');
  if (!authorization) return json(401, { error: 'unauthorized' });

  let input: { organization_id?: unknown; product_id?: unknown; kind?: unknown; brief?: unknown };
  try {
    input = await req.json();
  } catch {
    return json(400, { error: 'invalid_body' });
  }
  const orgId = String(input.organization_id ?? '');
  const productId = String(input.product_id ?? '');
  if (!UUID.test(orgId) || !UUID.test(productId)) return json(400, { error: 'invalid_body' });
  const kind = input.kind ?? 'description';
  if (kind !== 'description' && !GENERATION_KINDS.includes(kind as GenerationKind)) {
    return json(400, { error: 'invalid_body' });
  }
  const brief = input.brief ?? null;
  if (brief !== null && (typeof brief !== 'string' || brief.length > 300)) {
    return json(400, { error: 'invalid_body' });
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    console.error('ai: ANTHROPIC_API_KEY não configurada');
    return json(503, { error: 'not_configured' });
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (kind === 'description') return describe(supabase, apiKey, orgId, productId);
  return generate(supabase, apiKey, orgId, productId, kind as GenerationKind, brief);
});
