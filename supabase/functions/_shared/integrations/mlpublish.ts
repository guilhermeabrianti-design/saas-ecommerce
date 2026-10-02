import { str } from './common.ts';
import { ML_API } from './mercadolivre.ts';
import { StockPushError, type FetchFn } from './stock.ts';

/**
 * Publicação no Mercado Livre (Fase 37): código puro usado pela Edge
 * Function `mercadolivre` (/publish, /categories, /category) e testado com
 * vitest em `src/integrations/`.
 *
 * ATENÇÃO: formatos conforme a documentação pública (items, variations,
 * categories/attributes, domain_discovery). NÃO exercitado contra contas
 * reais nesta entrega: valide com um usuário de teste do Mercado Livre.
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Tipo de anúncio daqui → listing_type_id do Mercado Livre. */
export const ML_LISTING_TYPES: Record<string, string> = {
  classico: 'gold_special',
  premium: 'gold_pro',
};

/** Preenchidos pela TheSigns: não aparecem para o vendedor escolher. */
const AUTOMATIC = new Set(['SELLER_SKU', 'ITEM_CONDITION']);

export const ML_MAX_PICTURES = 10;
export const ML_DESCRIPTION_MAX = 50_000;

// ---------------------------------------------------------------------
// Categorias e atributos
// ---------------------------------------------------------------------

export interface MlCategorySuggestion {
  category_id: string;
  category_name: string;
  domain_name: string;
}

const CATEGORY_ID = /^MLB\d{1,15}$/;

export const validCategoryId = (v: unknown): v is string =>
  typeof v === 'string' && CATEGORY_ID.test(v);

/** GET /sites/MLB/domain_discovery/search → sugestões de categoria. */
export function parseCategorySuggestions(body: unknown): MlCategorySuggestion[] {
  const seen = new Set<string>();
  const out: MlCategorySuggestion[] = [];
  for (const raw of arr(body)) {
    const r = obj(raw);
    const id = str(r.category_id);
    if (!validCategoryId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      category_id: id,
      category_name: str(r.category_name).slice(0, 120),
      domain_name: str(r.domain_name).slice(0, 120),
    });
  }
  return out.slice(0, 8);
}

export interface MlAttributeValue {
  id: string;
  name: string;
}

export interface MlCategoryAttribute {
  id: string;
  name: string;
  required: boolean;
  /** Pode diferenciar variações (cor, tamanho...). */
  variation: boolean;
  value_type: string;
  values: MlAttributeValue[];
  units: MlAttributeValue[];
  hint: string;
}

/**
 * GET /categories/:id/attributes → atributos que o vendedor pode
 * preencher. Somem os escondidos, só leitura e os preenchidos aqui.
 * Obrigatório = `required` ou `catalog_required`.
 */
export function parseCategoryAttributes(body: unknown): MlCategoryAttribute[] {
  const out: MlCategoryAttribute[] = [];
  for (const raw of arr(body)) {
    const a = obj(raw);
    const id = str(a.id);
    const tags = obj(a.tags);
    if (!/^[A-Z0-9_]{1,60}$/.test(id) || AUTOMATIC.has(id)) continue;
    if (tags.hidden || tags.read_only || tags.fixed || tags.others) continue;
    const list = (v: unknown) =>
      arr(v)
        .map(obj)
        .map((x) => ({ id: String(x.id ?? ''), name: str(x.name) }))
        .filter((x) => /^[A-Za-z0-9_-]{1,40}$/.test(x.id) && x.name)
        .slice(0, 300);
    out.push({
      id,
      name: str(a.name).slice(0, 120) || id,
      required: Boolean(tags.required || tags.catalog_required),
      variation: Boolean(tags.allow_variations || tags.variation_attribute),
      value_type: str(a.value_type) || 'string',
      values: list(a.values),
      units: list(a.allowed_units),
      hint: str(a.hint).slice(0, 300),
    });
  }
  // Obrigatórios primeiro, na ordem da API.
  return [...out.filter((a) => a.required), ...out.filter((a) => !a.required)];
}

// ---------------------------------------------------------------------
// Montagem do anúncio
// ---------------------------------------------------------------------

export interface MlAttributeInput {
  id: string;
  value_id?: string;
  value_name?: string;
}

/** O que `ml_publish_begin` devolve. */
export interface PublishData {
  run_id: string;
  action: 'publish' | 'pause' | 'activate';
  organization_id: string;
  connection_id: string;
  external_id: string | null;
  config: {
    title: string;
    price_cents: number;
    listing_type: string;
    category: string | null;
    free_shipping: boolean;
    attributes: MlAttributeInput[];
    variation_map: Record<string, string>;
  };
  product: {
    sku: string;
    name: string;
    description: string;
    brand: string | null;
    gtin: string | null;
    inventory_item_id: string | null;
    available: number | null;
  };
  variants: {
    inventory_item_id: string;
    sku: string;
    attributes: Record<string, string>;
    gtin: string | null;
    available: number;
  }[];
  images: string[];
}

export interface MlVariationBody {
  id?: number | string;
  attribute_combinations: { id: string; value_name: string }[];
  price: number;
  available_quantity: number;
  picture_ids: string[];
  attributes: MlAttributeInput[];
}

export interface BuiltItem {
  body: Json;
  description: string;
  links: { inventory_item_id: string; sku: string }[];
  /** SKUs de variações novas sem estoque (o Mercado Livre não cria com zero). */
  skipped: string[];
}

export type BuildResult = { ok: true; item: BuiltItem } | { ok: false; errors: string[] };

const cents = (v: number) => Math.round(v) / 100;

/** Texto puro para a descrição (o Mercado Livre não aceita HTML). */
export function plainDescription(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, ML_DESCRIPTION_MAX);
}

const hasAttr = (attrs: MlAttributeInput[], id: string) => attrs.some((a) => a.id === id);

/**
 * Corpo de POST /items a partir da configuração do canal. Confere o que o
 * Mercado Livre recusaria antes de chamar a API: tipo de anúncio, foto,
 * estoque, atributos obrigatórios da categoria e o mapa das variações.
 * Com variações, o preço do canal vale para todas (exigência do Mercado
 * Livre: variações do mesmo anúncio têm o mesmo preço).
 */
export function buildMlItem(
  data: PublishData,
  pictureUrls: string[],
  categoryAttributes: MlCategoryAttribute[],
  opts: { existingVariationSkus?: string[] } = {},
): BuildResult {
  const errors: string[] = [];
  const cfg = data.config;
  const listingType = ML_LISTING_TYPES[cfg.listing_type];
  if (!listingType)
    errors.push(`Tipo de anúncio "${cfg.listing_type}" não existe no Mercado Livre.`);
  if (!validCategoryId(cfg.category)) errors.push('Escolha a categoria do Mercado Livre.');
  const pictures = pictureUrls.slice(0, ML_MAX_PICTURES);
  if (pictures.length === 0) errors.push('Adicione ao menos uma foto ao produto.');
  const price = cents(cfg.price_cents);

  const attributes: MlAttributeInput[] = cfg.attributes.map((a) => ({ ...a }));
  if (data.product.brand && !hasAttr(attributes, 'BRAND'))
    attributes.push({ id: 'BRAND', value_name: data.product.brand });

  const map = cfg.variation_map;
  const existing = new Set(opts.existingVariationSkus ?? []);
  const variations: MlVariationBody[] = [];
  const links: BuiltItem['links'] = [];
  const skipped: string[] = [];
  const mapped = new Set(Object.values(map));

  if (data.variants.length > 0) {
    const unmapped = new Set<string>();
    for (const v of data.variants) {
      for (const key of Object.keys(v.attributes)) if (!map[key]) unmapped.add(key);
    }
    for (const key of unmapped)
      errors.push(`Associe "${key}" a um atributo de variação do Mercado Livre.`);
    if (unmapped.size === 0) {
      const combos = new Set<string>();
      for (const v of data.variants) {
        const combination = Object.entries(v.attributes)
          .map(([k, value]) => ({ id: map[k]!, value_name: value }))
          .sort((a, b) => a.id.localeCompare(b.id));
        const key = JSON.stringify(combination);
        if (combos.has(key)) {
          errors.push(`Duas variações viram a mesma combinação no Mercado Livre (${v.sku}).`);
          continue;
        }
        combos.add(key);
        const available = Math.max(0, Math.trunc(v.available));
        if (available === 0 && !existing.has(v.sku)) {
          skipped.push(v.sku);
          continue;
        }
        const vAttrs: MlAttributeInput[] = [{ id: 'SELLER_SKU', value_name: v.sku }];
        const gtin = v.gtin ?? data.product.gtin;
        if (gtin && !hasAttr(attributes, 'GTIN')) vAttrs.push({ id: 'GTIN', value_name: gtin });
        variations.push({
          attribute_combinations: combination,
          price,
          available_quantity: available,
          picture_ids: pictures,
          attributes: vAttrs,
        });
        links.push({ inventory_item_id: v.inventory_item_id, sku: v.sku });
      }
      if (variations.length === 0 && errors.length === 0)
        errors.push('Nenhuma variação com estoque disponível para anunciar.');
    }
  } else {
    if (data.product.gtin && !hasAttr(attributes, 'GTIN'))
      attributes.push({ id: 'GTIN', value_name: data.product.gtin });
    attributes.push({ id: 'SELLER_SKU', value_name: data.product.sku });
    const available = Math.max(0, Math.trunc(data.product.available ?? 0));
    if (available === 0 && !data.external_id) errors.push('Sem estoque disponível para anunciar.');
    if (data.product.inventory_item_id)
      links.push({ inventory_item_id: data.product.inventory_item_id, sku: data.product.sku });
  }

  // Obrigatórios da categoria (os de variação contam pelo mapa).
  const provided = new Set(attributes.map((a) => a.id));
  if (data.variants.length > 0 && variations.some((v) => hasAttr(v.attributes, 'GTIN')))
    provided.add('GTIN');
  const missing = categoryAttributes.filter(
    (a) =>
      a.required &&
      !provided.has(a.id) &&
      !mapped.has(a.id) &&
      // Sem código de barras, vale o motivo informado.
      !(a.id === 'GTIN' && provided.has('EMPTY_GTIN_REASON')),
  );
  if (missing.length)
    errors.push(`Preencha os atributos obrigatórios: ${missing.map((a) => a.name).join(', ')}.`);

  if (errors.length) return { ok: false, errors };

  const body: Json = {
    title: cfg.title,
    category_id: cfg.category,
    currency_id: 'BRL',
    buying_mode: 'buy_it_now',
    condition: 'new',
    listing_type_id: listingType,
    pictures: pictures.map((source) => ({ source })),
    attributes,
    shipping: { mode: 'me2', local_pick_up: false, free_shipping: cfg.free_shipping },
  };
  if (variations.length) body.variations = variations;
  else {
    body.price = price;
    body.available_quantity = Math.max(0, Math.trunc(data.product.available ?? 0));
  }
  return {
    ok: true,
    item: { body, description: plainDescription(data.product.description), links, skipped },
  };
}

const variationSku = (v: Json) =>
  str(v.seller_custom_field) ||
  str(
    obj(
      arr(v.attributes)
        .map(obj)
        .find((a) => a.id === 'SELLER_SKU'),
    ).value_name,
  );

/** SKUs das variações de um anúncio já publicado (GET /items/:id). */
export const existingVariationSkus = (item: unknown) =>
  arr(obj(item).variations).map(obj).map(variationSku).filter(Boolean);

/**
 * Corpo de PUT /items/:id para atualizar um anúncio publicado. Título só
 * muda sem vendas; categoria, moeda, condição e tipo de anúncio não mudam
 * por aqui. Variações existentes são casadas pelo SKU e mantidas (com o
 * estoque atual, mesmo zero); as novas entram sem id.
 */
export function buildMlUpdate(existing: unknown, built: BuiltItem): Json {
  const item = obj(existing);
  const b = built.body;
  const body: Json = {
    pictures: b.pictures,
    attributes: b.attributes,
    shipping: b.shipping,
  };
  if (Number(item.sold_quantity ?? 0) === 0) body.title = b.title;
  const next = arr(b.variations) as MlVariationBody[];
  if (next.length) {
    const ids = new Map(
      arr(item.variations)
        .map(obj)
        .map((v) => [variationSku(v), v.id] as const),
    );
    body.variations = next.map((v) => {
      const sku = str(v.attributes.find((a) => a.id === 'SELLER_SKU')?.value_name);
      const id = ids.get(sku);
      return id == null
        ? v
        : {
            id,
            price: v.price,
            available_quantity: v.available_quantity,
            picture_ids: v.picture_ids,
            attributes: v.attributes,
          };
    });
  } else {
    body.price = b.price;
    body.available_quantity = b.available_quantity;
  }
  return body;
}

/** Status do anúncio no Mercado Livre → status gravado aqui. */
export function publishStatus(item: unknown): 'active' | 'paused' | 'closed' {
  const s = str(obj(item).status);
  if (s === 'active') return 'active';
  if (s === 'closed') return 'closed';
  return 'paused';
}

export function parseItem(body: unknown): { id: string; permalink: string | null } {
  const b = obj(body);
  const id = String(b.id ?? '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id))
    throw new StockPushError('Mercado Livre: resposta sem id do anúncio');
  const link = str(b.permalink);
  return { id, permalink: /^https:\/\//.test(link) && link.length <= 500 ? link : null };
}

// ---------------------------------------------------------------------
// Chamadas
// ---------------------------------------------------------------------

/** Mensagem legível de um erro da API (message + causas). */
export function mlErrorMessage(status: number, body: unknown): string {
  const b = obj(body);
  const causes = arr(b.cause)
    .map(obj)
    .filter((c) => str(c.type) !== 'warning')
    .map((c) => str(c.message))
    .filter(Boolean);
  const main = str(b.message);
  const parts = [main, ...causes].filter((v, i, all) => v && all.indexOf(v) === i);
  return `Mercado Livre: ${parts.length ? parts.join(' · ') : `HTTP ${status}`}`.slice(0, 900);
}

export async function mlSend(
  fetchFn: FetchFn,
  accessToken: string | null,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<unknown> {
  let res: Response;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  try {
    res = await fetchFn(`${ML_API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new StockPushError('Mercado Livre: sem resposta (rede ou tempo esgotado)');
  }
  const parsed = await res.json().catch(() => null);
  // 403 também vem com motivo (ex.: conta sem permissão na categoria): vai para a mensagem.
  if (res.status === 401)
    throw new StockPushError('Mercado Livre: acesso recusado (reconecte a conta)');
  if (res.status === 429) throw new StockPushError('Mercado Livre: limite de requisições');
  if (!res.ok) throw new StockPushError(mlErrorMessage(res.status, parsed));
  return parsed;
}
