import { str } from './common.ts';
import type { MlCategoryAttribute, MlCategorySuggestion, PublishData } from './mlpublish.ts';
import {
  categoryPath,
  missingAttributes,
  variantTiers,
  type CategoryNode,
} from './publishcommon.ts';
import { StockPushError, type FetchFn } from './stock.ts';
import { tiktokUrl, unwrapTikTok, type TikTokApp } from './tiktok.ts';

/**
 * Publicação na TikTok Shop (Fase 44): código puro usado pela Edge
 * Function `tiktok` (/categories, /category, /publish), testado com vitest.
 *
 * Fluxo: fotos → product/images/upload; criar (POST products) ou atualizar
 * (PUT products/:id, SKUs existentes pelo id); pausar e reativar:
 * products/deactivate e products/activate. Variações vão pelo nome da
 * característica (sales_attributes), até 3.
 *
 * ATENÇÃO: formatos conforme a documentação pública (Partner API 202309).
 * NÃO exercitado contra contas reais.
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const TIKTOK_MAX_IMAGES = 9;
export const TIKTOK_DESCRIPTION_MAX = 10_000;
export const TIKTOK_LOCALE = 'pt-BR';

const CATEGORY_ID = /^\d{1,20}$/;
export const validTikTokCategory = (v: unknown): v is string =>
  typeof v === 'string' && CATEGORY_ID.test(v);

// ---------------------------------------------------------------------
// Categorias e atributos
// ---------------------------------------------------------------------

/** GET /product/202309/categories → árvore. */
export function parseTikTokCategories(data: unknown): Map<string, CategoryNode> {
  const nodes = new Map<string, CategoryNode>();
  for (const raw of arr(obj(data).categories)) {
    const c = obj(raw);
    const id = String(c.id ?? '');
    if (!CATEGORY_ID.test(id)) continue;
    const parent = String(c.parent_id ?? '0');
    nodes.set(id, {
      id,
      parent: parent === '0' || parent === '' ? null : parent,
      name: (str(c.local_name) || str(c.name) || id).slice(0, 120),
      leaf: Boolean(c.is_leaf),
    });
  }
  return nodes;
}

/** POST /product/202309/categories/recommend → sugestão (categoria final + caminho). */
export function parseTikTokRecommend(data: unknown): MlCategorySuggestion[] {
  const d = obj(data);
  const leaf = String(d.leaf_category_id ?? '');
  if (!CATEGORY_ID.test(leaf)) return [];
  const nodes = new Map<string, CategoryNode>();
  const chain = arr(d.categories)
    .map(obj)
    .sort((a, b) => Number(a.level ?? 0) - Number(b.level ?? 0));
  let parent: string | null = null;
  for (const c of chain) {
    const id = String(c.id ?? '');
    if (!CATEGORY_ID.test(id)) continue;
    nodes.set(id, { id, parent, name: str(c.name).slice(0, 120) || id, leaf: Boolean(c.is_leaf) });
    parent = id;
  }
  return [{ category_id: leaf, category_name: categoryPath(nodes, leaf) || leaf, domain_name: '' }];
}

/**
 * Atributos do produto da categoria (os de venda — cor, tamanho — vêm das
 * variações pelo nome) no mesmo formato da tela do Mercado Livre.
 */
export function parseTikTokAttributes(data: unknown): MlCategoryAttribute[] {
  const out: MlCategoryAttribute[] = [];
  for (const raw of arr(obj(data).attributes)) {
    const a = obj(raw);
    const id = String(a.id ?? '');
    if (!/^\d{1,20}$/.test(id) || str(a.type) !== 'PRODUCT_PROPERTY') continue;
    const values = arr(a.values)
      .map(obj)
      .map((v) => ({ id: String(v.id ?? ''), name: str(v.name) }))
      .filter((v) => /^\d{1,20}$/.test(v.id) && v.name)
      .slice(0, 300);
    const customizable = Boolean(a.is_customizable);
    out.push({
      id,
      name: (str(a.name) || id).slice(0, 120),
      // A API escreve "is_requried".
      required: Boolean(a.is_requried ?? a.is_required),
      variation: false,
      value_type: values.length && !customizable ? 'list' : 'string',
      values: values.length && !customizable ? values : [],
      units: [],
      hint: customizable && values.length ? `Ex.: ${values[0]!.name}` : '',
    });
  }
  return [...out.filter((a) => a.required), ...out.filter((a) => !a.required)];
}

/** Depósito de venda padrão da loja. */
export function defaultWarehouse(data: unknown): string | null {
  const list = arr(obj(data).warehouses)
    .map(obj)
    .filter((w) => str(w.type) === 'SALES_WAREHOUSE' && str(w.effect_status) !== 'DISABLED');
  const pick = list.find((w) => w.is_default === true) ?? list[0];
  const id = String(pick?.id ?? '');
  return /^\d{1,30}$/.test(id) ? id : null;
}

// ---------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------

const amount = (cents: number) => (Math.round(cents) / 100).toFixed(2);

/** Descrição em HTML simples (parágrafos), como a TikTok Shop pede. */
export function htmlDescription(text: string, fallback: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paragraphs = text
    .replace(/<[^>]*>/g, ' ')
    .split(/\n{2,}|\r\n\r\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const html = (paragraphs.length ? paragraphs : [fallback])
    .map((p) => `<p>${escape(p)}</p>`)
    .join('');
  return html.slice(0, TIKTOK_DESCRIPTION_MAX);
}

export interface BuiltTikTokProduct {
  body: Json;
  links: { inventory_item_id: string; sku: string }[];
}

export type TikTokBuild = { ok: true; item: BuiltTikTokProduct } | { ok: false; errors: string[] };

/**
 * Corpo de criar/atualizar o produto. Confere antes o que a TikTok Shop
 * recusaria: categoria, foto, peso, depósito, atributos obrigatórios e
 * variações (até 3 características). `existingSkus` (SKU do vendedor → id
 * na TikTok) mantém os SKUs de um produto já publicado.
 */
export function buildTikTokProduct(
  data: PublishData,
  imageUris: string[],
  attrs: MlCategoryAttribute[],
  warehouseId: string | null,
  existingSkus: Map<string, string> = new Map(),
): TikTokBuild {
  const errors: string[] = [];
  const cfg = data.config;
  if (!validTikTokCategory(cfg.category)) errors.push('Escolha a categoria da TikTok Shop.');
  const images = imageUris.slice(0, TIKTOK_MAX_IMAGES);
  if (images.length === 0) errors.push('Adicione ao menos uma foto ao produto.');
  const grams = data.product.weight_grams ?? 0;
  if (!grams || grams <= 0) errors.push('Informe o peso do produto (a TikTok Shop exige).');
  if (!warehouseId) errors.push('A loja da TikTok Shop não tem depósito de venda ativo.');
  const missing = missingAttributes(
    attrs.filter((a) => a.required),
    cfg.attributes,
  );
  if (missing.length) errors.push(`Preencha os atributos obrigatórios: ${missing.join(', ')}.`);

  const price = { amount: amount(cfg.price_cents), currency: 'BRL' };
  const skus: Json[] = [];
  const links: BuiltTikTokProduct['links'] = [];
  const sku = (seller: string, quantity: number, sales?: Json[]) => {
    const body: Json = {
      seller_sku: seller.slice(0, 50),
      price,
      inventory: [{ warehouse_id: warehouseId, quantity: Math.max(0, Math.trunc(quantity)) }],
    };
    if (sales) body.sales_attributes = sales;
    const id = existingSkus.get(seller);
    if (id) body.id = id;
    return body;
  };

  if (data.variants.length > 0) {
    const t = variantTiers(data, 3, 'A TikTok Shop');
    if (!t.ok) errors.push(...t.errors);
    else {
      data.variants.forEach((v, i) => {
        const sales = t.tiers.names.map((name, n) => ({
          name: name.slice(0, 20),
          value_name: t.tiers.options[n]![t.tiers.indexes[i]![n]!]!.slice(0, 50),
        }));
        skus.push(sku(v.sku, v.available, sales));
        links.push({ inventory_item_id: v.inventory_item_id, sku: v.sku });
      });
    }
  } else {
    skus.push(sku(data.product.sku, data.product.available ?? 0));
    if (data.product.inventory_item_id)
      links.push({ inventory_item_id: data.product.inventory_item_id, sku: data.product.sku });
  }
  if (errors.length) return { ok: false, errors };

  const body: Json = {
    title: cfg.title,
    description: htmlDescription(data.product.description || '', cfg.title),
    category_id: cfg.category,
    main_images: images.map((uri) => ({ uri })),
    skus,
    package_weight: { value: (Math.round(grams) / 1000).toFixed(3), unit: 'KILOGRAM' },
    product_attributes: cfg.attributes.map((a) => ({
      id: a.id,
      values: [a.value_id ? { id: a.value_id } : { name: str(a.value_name) }],
    })),
    is_cod_allowed: false,
  };
  const { length_mm: l, width_mm: w, height_mm: h } = data.product;
  if (l && w && h) {
    body.package_dimensions = {
      length: String(Math.max(1, Math.ceil(l / 10))),
      width: String(Math.max(1, Math.ceil(w / 10))),
      height: String(Math.max(1, Math.ceil(h / 10))),
      unit: 'CENTIMETER',
    };
  }
  return { ok: true, item: { body, links } };
}

/** SKUs de um produto (GET products/:id ou resposta de criar) → SKU do vendedor → id. */
export function tiktokSkuIds(data: unknown): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of arr(obj(data).skus).map(obj)) {
    const seller = str(s.seller_sku);
    const id = String(s.id ?? '');
    if (seller && /^\d{1,30}$/.test(id)) map.set(seller, id);
  }
  return map;
}

/** status do produto → estado gravado aqui. */
export function tiktokProductStatus(status: unknown): 'active' | 'review' | 'paused' | 'closed' {
  const s = str(status);
  if (s === 'ACTIVATE') return 'active';
  if (s === 'PENDING' || s === 'DRAFT') return 'review';
  if (s === 'DELETED') return 'closed';
  return 'paused';
}

/** Envia uma foto (multipart; a assinatura não inclui o corpo) e devolve o uri. */
export async function uploadTikTokImage(
  fetchFn: FetchFn,
  app: TikTokApp,
  accessToken: string,
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
): Promise<string> {
  const form = new FormData();
  form.append('data', new Blob([bytes], { type: contentType }), 'foto');
  form.append('use_case', 'MAIN_IMAGE');
  let res: Response;
  try {
    res = await fetchFn(await tiktokUrl(app, '/product/202309/images/upload', {}), {
      method: 'POST',
      headers: { 'x-tts-access-token': accessToken },
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new StockPushError('TikTok Shop: sem resposta ao enviar foto');
  }
  const data = unwrapTikTok(res.status, await res.json().catch(() => null));
  const uri = str(data.uri);
  if (!uri || uri.length > 300) throw new StockPushError('TikTok Shop: foto sem identificador');
  return uri;
}
