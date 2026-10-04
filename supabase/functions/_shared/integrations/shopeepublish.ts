import { str } from './common.ts';
import type { MlCategoryAttribute, PublishData } from './mlpublish.ts';
import { missingAttributes, plainText, variantTiers, type CategoryNode } from './publishcommon.ts';
import { shopeeUrl, unwrapShopee, type ShopeeApp } from './shopee.ts';
import { StockPushError, type FetchFn } from './stock.ts';

/**
 * Publicação na Shopee (Fase 44): código puro usado pela Edge Function
 * `shopee` (/categories, /category, /publish), testado com vitest.
 *
 * Fluxo: fotos → media_space/upload_image; add_item (item com preço e
 * estoque); com variações, init_tier_variation (até 2 características).
 * Atualizar: update_item + update_price + update_stock das variações que
 * já existem (variação nova precisa ser criada na Shopee). Pausar e
 * reativar: unlist_item.
 *
 * ATENÇÃO: formatos conforme a documentação pública da Shopee Open
 * Platform v2. NÃO exercitado contra contas reais.
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const SHOPEE_MAX_IMAGES = 9;
export const SHOPEE_DESCRIPTION_MAX = 3000;
export const SHOPEE_LANGUAGE = 'pt-br';

const CATEGORY_ID = /^\d{1,15}$/;
export const validShopeeCategory = (v: unknown): v is string =>
  typeof v === 'string' && CATEGORY_ID.test(v);

// ---------------------------------------------------------------------
// Categorias e atributos
// ---------------------------------------------------------------------

/** get_category → árvore de categorias. */
export function parseShopeeCategories(response: unknown): Map<string, CategoryNode> {
  const nodes = new Map<string, CategoryNode>();
  for (const raw of arr(obj(response).category_list)) {
    const c = obj(raw);
    const id = String(c.category_id ?? '');
    if (!CATEGORY_ID.test(id)) continue;
    const parent = String(c.parent_category_id ?? '0');
    nodes.set(id, {
      id,
      parent: parent === '0' ? null : parent,
      name: (str(c.display_category_name) || str(c.original_category_name) || id).slice(0, 120),
      leaf: !c.has_children,
    });
  }
  return nodes;
}

/** category_recommend → ids sugeridos. */
export const parseShopeeRecommend = (response: unknown): string[] =>
  arr(obj(response).category_id)
    .map(String)
    .filter((id) => CATEGORY_ID.test(id));

/**
 * get_attributes → atributos no mesmo formato do Mercado Livre (a tela é a
 * mesma). Valores da lista vão pelo id; texto livre pelo nome.
 */
export function parseShopeeAttributes(response: unknown): MlCategoryAttribute[] {
  const out: MlCategoryAttribute[] = [];
  for (const raw of arr(obj(response).attribute_list)) {
    const a = obj(raw);
    const id = String(a.attribute_id ?? '');
    if (!/^\d{1,15}$/.test(id)) continue;
    const values = arr(a.attribute_value_list)
      .map(obj)
      .map((v) => ({
        id: String(v.value_id ?? ''),
        name: str(v.display_value_name) || str(v.original_value_name),
      }))
      .filter((v) => /^\d{1,15}$/.test(v.id) && v.name)
      .slice(0, 300);
    const input = str(a.input_type);
    const validation = str(a.input_validation_type);
    out.push({
      id,
      name: (str(a.display_attribute_name) || str(a.original_attribute_name) || id).slice(0, 120),
      required: Boolean(a.is_mandatory),
      variation: false,
      value_type:
        values.length && input !== 'TEXT_FILED'
          ? 'list'
          : /INT|FLOAT/.test(validation)
            ? 'number'
            : 'string',
      values: input === 'TEXT_FILED' ? [] : values,
      units: arr(a.attribute_unit)
        .map(String)
        .filter(Boolean)
        .slice(0, 20)
        .map((u) => ({ id: u, name: u })),
      hint: '',
    });
  }
  return [...out.filter((a) => a.required), ...out.filter((a) => !a.required)];
}

export interface ShopeeLogistic {
  id: number;
  name: string;
}

/** get_channel_list → canais de envio ligados na loja. */
export function parseShopeeLogistics(response: unknown): ShopeeLogistic[] {
  return arr(obj(response).logistics_channel_list)
    .map(obj)
    .filter((c) => c.enabled === true && Number.isInteger(Number(c.logistics_channel_id)))
    .map((c) => ({
      id: Number(c.logistics_channel_id),
      name: str(c.logistics_channel_name).slice(0, 80),
    }));
}

// ---------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------

const price = (cents: number) => Math.round(cents) / 100;

export interface ShopeeModel {
  sku: string;
  inventory_item_id: string;
  tier_index: number[];
  stock: number;
}

export interface BuiltShopeeItem {
  /** add_item / update_item. */
  body: Json;
  /** init_tier_variation sem o item_id (com variações). */
  tiers: { name: string; option_list: { option: string }[] }[] | null;
  models: ShopeeModel[];
  price: number;
  /** Sem variações: o item é o próprio SKU. */
  single: { sku: string; inventory_item_id: string | null; stock: number } | null;
}

export type ShopeeBuild = { ok: true; item: BuiltShopeeItem } | { ok: false; errors: string[] };

/**
 * Corpo do anúncio a partir da configuração do canal. Confere antes o que
 * a Shopee recusaria: categoria, foto, peso, canal de envio, atributos
 * obrigatórios e as variações (até 2 características). Variações saem
 * todas pelo preço do canal.
 */
export function buildShopeeItem(
  data: PublishData,
  imageIds: string[],
  attrs: MlCategoryAttribute[],
  logistics: ShopeeLogistic[],
): ShopeeBuild {
  const errors: string[] = [];
  const cfg = data.config;
  if (!validShopeeCategory(cfg.category)) errors.push('Escolha a categoria da Shopee.');
  const images = imageIds.slice(0, SHOPEE_MAX_IMAGES);
  if (images.length === 0) errors.push('Adicione ao menos uma foto ao produto.');
  const grams = data.product.weight_grams ?? 0;
  if (!grams || grams <= 0) errors.push('Informe o peso do produto (a Shopee exige).');
  if (logistics.length === 0)
    errors.push('Ative ao menos um canal de envio na sua loja da Shopee.');
  const missing = missingAttributes(
    attrs.filter((a) => a.required),
    cfg.attributes,
  );
  if (missing.length) errors.push(`Preencha os atributos obrigatórios: ${missing.join(', ')}.`);

  let tiers: BuiltShopeeItem['tiers'] = null;
  const models: ShopeeModel[] = [];
  if (data.variants.length > 0) {
    const t = variantTiers(data, 2, 'A Shopee');
    if (!t.ok) errors.push(...t.errors);
    else {
      tiers = t.tiers.names.map((name, i) => ({
        name: name.slice(0, 20),
        option_list: t.tiers.options[i]!.map((option) => ({ option: option.slice(0, 50) })),
      }));
      data.variants.forEach((v, i) =>
        models.push({
          sku: v.sku,
          inventory_item_id: v.inventory_item_id,
          tier_index: t.tiers.indexes[i]!,
          stock: Math.max(0, Math.trunc(v.available)),
        }),
      );
    }
  }
  if (errors.length) return { ok: false, errors };

  const byId = new Map(attrs.map((a) => [a.id, a]));
  const attributeList = cfg.attributes.map((a) => {
    const def = byId.get(a.id);
    const value: Json = a.value_id
      ? { value_id: Number(a.value_id) }
      : { value_id: 0, original_value_name: str(a.value_name) };
    // Número com unidade ("10 cm"): a Shopee quer o número e a unidade à parte.
    if (!a.value_id && def?.units.length) {
      const m = /^([\d.,]+)\s*(\S+)?$/.exec(str(a.value_name));
      if (m) {
        value.original_value_name = m[1]!.replace(',', '.');
        value.value_unit = m[2] && def.units.some((u) => u.id === m[2]) ? m[2] : def.units[0]!.id;
      }
    }
    return { attribute_id: Number(a.id), attribute_value_list: [value] };
  });

  const description =
    plainText(data.product.description || '', SHOPEE_DESCRIPTION_MAX) || cfg.title;
  const total = tiers
    ? models.reduce((s, m) => s + m.stock, 0)
    : Math.max(0, Math.trunc(data.product.available ?? 0));
  const body: Json = {
    item_name: cfg.title,
    description,
    original_price: price(cfg.price_cents),
    seller_stock: [{ stock: total }],
    weight: Math.max(0.01, Math.round(grams) / 1000),
    image: { image_id_list: images },
    category_id: Number(cfg.category),
    attribute_list: attributeList,
    brand: { brand_id: 0, original_brand_name: 'NoBrand' },
    logistic_info: logistics.map((l) => ({
      logistic_id: l.id,
      enabled: true,
      is_free: cfg.free_shipping,
    })),
    condition: 'NEW',
    item_status: 'NORMAL',
    item_sku: data.product.sku.slice(0, 100),
  };
  const { length_mm: l, width_mm: w, height_mm: h } = data.product;
  if (l && w && h) {
    body.dimension = {
      package_length: Math.max(1, Math.ceil(l / 10)),
      package_width: Math.max(1, Math.ceil(w / 10)),
      package_height: Math.max(1, Math.ceil(h / 10)),
    };
  }
  return {
    ok: true,
    item: {
      body,
      tiers,
      models,
      price: price(cfg.price_cents),
      single: tiers
        ? null
        : {
            sku: data.product.sku,
            inventory_item_id: data.product.inventory_item_id,
            stock: total,
          },
    },
  };
}

/** init_tier_variation do item recém-criado. */
export function tierVariationBody(itemId: string, item: BuiltShopeeItem): Json {
  return {
    item_id: Number(itemId),
    tier_variation: item.tiers,
    model: item.models.map((m) => ({
      tier_index: m.tier_index,
      original_price: item.price,
      model_sku: m.sku.slice(0, 100),
      seller_stock: [{ stock: m.stock }],
    })),
  };
}

/** update_item: tudo do anúncio menos estoque, preço e variações. */
export function updateItemBody(itemId: string, item: BuiltShopeeItem): Json {
  const b = { ...item.body };
  delete b.seller_stock;
  delete b.original_price;
  delete b.item_status;
  return { item_id: Number(itemId), ...b };
}

/** get_model_list → SKU da variação → id. */
export function modelIds(response: unknown): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of arr(obj(response).model).map(obj)) {
    const sku = str(m.model_sku);
    const id = String(m.model_id ?? '');
    if (sku && /^\d{1,20}$/.test(id)) map.set(sku, id);
  }
  return map;
}

/** item_status → estado gravado aqui. */
export function shopeeItemStatus(status: unknown): 'active' | 'review' | 'paused' | 'closed' {
  const s = str(status);
  if (s === 'NORMAL') return 'active';
  if (s === 'REVIEWING') return 'review';
  if (s === 'UNLIST') return 'paused';
  return 'closed';
}

export const shopeeItemUrl = (shopId: string | undefined, itemId: string) =>
  shopId && /^\d{1,20}$/.test(shopId) && /^\d{1,20}$/.test(itemId)
    ? `https://shopee.com.br/product/${shopId}/${itemId}`
    : null;

/** Envia uma foto ao espaço de mídia da Shopee (chamada sem loja) e devolve o image_id. */
export async function uploadShopeeImage(
  fetchFn: FetchFn,
  app: ShopeeApp,
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
): Promise<string> {
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: contentType }), 'foto');
  let res: Response;
  try {
    res = await fetchFn(await shopeeUrl(app, '/api/v2/media_space/upload_image'), {
      method: 'POST',
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new StockPushError('Shopee: sem resposta ao enviar foto');
  }
  const response = unwrapShopee(res.status, await res.json().catch(() => null));
  const info = obj(response.image_info);
  const id = str(info.image_id) || str(obj(arr(response.image_info_list)[0]).image_id);
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) throw new StockPushError('Shopee: foto sem id');
  return id;
}
