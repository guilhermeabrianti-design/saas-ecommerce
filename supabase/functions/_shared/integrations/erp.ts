import { StockPushError, type FetchFn } from './stock.ts';

/**
 * ERPs (Fase 36): Bling (API v3, OAuth 2.0) e Tiny/Olist (API 2.0, token).
 * Só leitura de estoque: o ERP é a fonte do saldo e a nossa base segue.
 * Código puro usado pela Edge Function `erp`, testado com vitest em
 * `src/integrations/`.
 *
 * ATENÇÃO: formatos conforme a documentação pública (developer.bling.com.br
 * e tiny.com.br/api-docs). NÃO exercitado contra contas reais nesta
 * entrega: valide com uma conta de teste de cada ERP antes de produção.
 */

export const BLING_AUTH_URL = 'https://www.bling.com.br/Api/v3/oauth/authorize';
export const BLING_API = 'https://api.bling.com.br/Api/v3';
export const TINY_API = 'https://api.tiny.com.br/api2';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export interface StockRow {
  sku: string;
  quantity: number;
}

/** Saldo do ERP → inteiro ≥ 0 (unidades fracionadas são arredondadas para baixo). */
export function toQuantity(v: unknown): number | null {
  // Sem saldo informado ≠ saldo zero: nunca zerar o estoque por campo ausente.
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

async function request(fetchFn: FetchFn, url: string, init: RequestInit, label: string) {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new StockPushError(`${label}: sem resposta (rede ou tempo esgotado)`);
  }
  if (res.status === 401 || res.status === 403)
    throw new StockPushError(`${label}: acesso recusado (reconecte a conta)`);
  if (res.status === 429) throw new StockPushError(`${label}: limite de requisições`);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new StockPushError(`${label}: HTTP ${res.status}`);
  return body;
}

// ---------------------------------------------------------------------
// Bling
// ---------------------------------------------------------------------

export function blingAuthorizationUrl(clientId: string, state: string): string {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, state });
  return `${BLING_AUTH_URL}?${q.toString()}`;
}

export interface BlingTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export function parseBlingToken(body: unknown): BlingTokens {
  const b = obj(body);
  const access = str(b.access_token);
  const refresh = str(b.refresh_token);
  const expires = Number(b.expires_in);
  if (!access || !refresh || !Number.isFinite(expires) || expires <= 0) {
    throw new StockPushError('Bling: resposta de token inválida');
  }
  return { access_token: access, refresh_token: refresh, expires_in: expires };
}

/** POST /oauth/token com as credenciais do app em Basic (código ou renovação). */
export async function blingToken(
  fetchFn: FetchFn,
  args: { clientId: string; clientSecret: string; body: Record<string, string> },
): Promise<BlingTokens> {
  const basic = btoa(`${args.clientId}:${args.clientSecret}`);
  const res = await request(
    fetchFn,
    `${BLING_API}/oauth/token`,
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: '1.0',
        'enable-jwt': '1',
      },
      body: new URLSearchParams(args.body).toString(),
    },
    'Bling',
  );
  return parseBlingToken(res);
}

export const BLING_BATCH = 100;

/** Saldo por SKU: GET /produtos?codigos[]=…, usando `estoque.saldoVirtualTotal`. */
export function parseBlingProducts(body: unknown): StockRow[] {
  return arr(obj(body).data).flatMap((raw) => {
    const p = obj(raw);
    const sku = str(p.codigo);
    const quantity = toQuantity(obj(p.estoque).saldoVirtualTotal);
    return sku && quantity !== null ? [{ sku, quantity }] : [];
  });
}

export async function blingStock(
  fetchFn: FetchFn,
  accessToken: string,
  skus: string[],
): Promise<StockRow[]> {
  const rows: StockRow[] = [];
  for (let i = 0; i < skus.length; i += BLING_BATCH) {
    const q = new URLSearchParams({ pagina: '1', limite: String(BLING_BATCH) });
    for (const sku of skus.slice(i, i + BLING_BATCH)) q.append('codigos[]', sku);
    const body = await request(
      fetchFn,
      `${BLING_API}/produtos?${q.toString()}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      },
      'Bling',
    );
    rows.push(...parseBlingProducts(body));
  }
  return rows;
}

// ---------------------------------------------------------------------
// Tiny / Olist
// ---------------------------------------------------------------------

export const TINY_FIRST_CURSOR = '01/01/2000 00:00:00';

/** Agora no horário de Brasília, no formato do Tiny (dd/mm/yyyy hh:mm:ss). */
export function tinyCursor(now: Date): string {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

async function tinyPost(fetchFn: FetchFn, service: string, params: Record<string, string>) {
  const body = await request(
    fetchFn,
    `${TINY_API}/${service}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, formato: 'json' }).toString(),
    },
    'Tiny',
  );
  return obj(obj(body).retorno);
}

const tinyErrors = (r: Json) =>
  arr(r.erros)
    .map((e) => str(obj(e).erro))
    .filter(Boolean)
    .join('; ');

/** Confere o token (info.php). Devolve o nome da conta quando houver. */
export async function tinyCheckToken(fetchFn: FetchFn, token: string): Promise<string> {
  const r = await tinyPost(fetchFn, 'info.php', { token });
  if (str(r.status) !== 'OK') {
    throw new StockPushError(`Tiny: token recusado${tinyErrors(r) ? ` (${tinyErrors(r)})` : ''}`);
  }
  return str(obj(r.conta).razao_social) || str(obj(r.conta).fantasia) || 'Tiny';
}

/**
 * Atualizações de estoque desde `since` (lista.atualizacoes.estoque, todas
 * as páginas). A fila do Tiny entrega cada atualização uma vez; "sem
 * registros" (código 20) é lista vazia.
 */
export async function tinyStockUpdates(
  fetchFn: FetchFn,
  token: string,
  since: string,
  maxPages = 50,
): Promise<StockRow[]> {
  const rows: StockRow[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await tinyPost(fetchFn, 'lista.atualizacoes.estoque', {
      token,
      dataAlteracao: since,
      pagina: String(page),
    });
    if (str(r.status) !== 'OK') {
      if (String(r.codigo_erro) === '20') break;
      throw new StockPushError(
        `Tiny: ${tinyErrors(r) || 'erro ao ler o estoque'} (confira a extensão "API para estoque em tempo real")`,
      );
    }
    for (const raw of arr(r.produtos)) {
      const p = obj(obj(raw).produto);
      const sku = str(p.codigo);
      const quantity = toQuantity(p.saldo);
      if (sku && quantity !== null) rows.push({ sku, quantity });
    }
    const pages = Number(r.numero_paginas);
    if (!Number.isFinite(pages) || page >= pages) break;
  }
  return rows;
}
