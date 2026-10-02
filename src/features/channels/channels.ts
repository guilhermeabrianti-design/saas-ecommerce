import { z } from 'zod';
import type { FeeOptions } from '@/features/fees/fees';
import { providers, type Provider } from '@/features/integrations/schemas';
import { centsToInput, parseBRL } from '@/utils/money';
import { publishStatuses, savedAttributeSchema } from './ml-publish';

/** Limite de título de cada canal (o banco confere o mesmo). */
export const TITLE_LIMITS: Record<Provider, number> = {
  mercadolivre: 60,
  shopee: 120,
  tiktok: 255,
};

/** Mercado Livre: frete grátis obrigatório a partir deste preço (Brasil). */
export const ML_FREE_SHIPPING_FROM_CENTS = 7900;

export const channelConfigSchema = z.object({
  id: z.uuid(),
  product_id: z.uuid(),
  provider: z.enum(providers),
  enabled: z.boolean(),
  title: z.string(),
  price_cents: z.number().int(),
  listing_type: z.string(),
  category_id: z.uuid().nullable(),
  marketplace_category: z.string().nullable(),
  free_shipping: z.boolean(),
  updated_at: z.string(),
  // Publicação no Mercado Livre (Fase 37).
  attributes: z.array(savedAttributeSchema),
  variation_map: z.record(z.string(), z.string()),
  external_id: z.string().nullable(),
  external_url: z.string().nullable(),
  publish_status: z.enum(publishStatuses).nullable(),
  last_error: z.string().nullable(),
  published_at: z.string().nullable(),
});
export type ChannelConfig = z.infer<typeof channelConfigSchema>;

export interface ChannelForm {
  enabled: boolean;
  title: string;
  price: string;
  listingType: string;
  categoryId: string;
  marketplaceCategory: string;
  freeShipping: boolean;
}

/** Corta no limite do canal sem deixar palavra pela metade quando dá. */
export function fitTitle(name: string, limit: number): string {
  const clean = name.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return (space > limit * 0.6 ? cut.slice(0, space) : cut).trim();
}

/** Tipo de anúncio padrão: Clássico no Mercado Livre; senão o primeiro com taxa. */
export function defaultListingType(provider: Provider, options: FeeOptions[]): string {
  const types = options.find((o) => o.provider === provider)?.types ?? [];
  return (types.find((t) => t.value === 'classico') ?? types[0])?.value ?? '';
}

/**
 * Formulário do canal: o que está salvo ou, sem nada salvo, uma sugestão a
 * partir do produto (nome, preço, categoria do catálogo).
 */
export function channelForm(
  provider: Provider,
  saved: ChannelConfig | undefined,
  product: { name: string; price_cents: number; category_id?: string | null },
  options: FeeOptions[],
): ChannelForm {
  if (saved) {
    return {
      enabled: saved.enabled,
      title: saved.title,
      price: centsToInput(saved.price_cents),
      listingType: saved.listing_type,
      categoryId: saved.category_id ?? '',
      marketplaceCategory: saved.marketplace_category ?? '',
      freeShipping: saved.free_shipping,
    };
  }
  return {
    enabled: true,
    title: fitTitle(product.name, TITLE_LIMITS[provider]),
    price: centsToInput(product.price_cents),
    listingType: defaultListingType(provider, options),
    categoryId: product.category_id ?? '',
    marketplaceCategory: '',
    freeShipping: provider === 'mercadolivre' && product.price_cents >= ML_FREE_SHIPPING_FROM_CENTS,
  };
}

export type ChannelErrors = Partial<
  Record<'title' | 'price' | 'listingType' | 'marketplaceCategory', string>
>;

export function validateChannel(provider: Provider, f: ChannelForm): ChannelErrors {
  const errors: ChannelErrors = {};
  const title = f.title.trim();
  if (!title) errors.title = 'Informe o título';
  else if (title.length > TITLE_LIMITS[provider])
    errors.title = `Máximo de ${TITLE_LIMITS[provider]} caracteres neste canal`;
  const price = parseBRL(f.price);
  if (price === null || price < 1) errors.price = 'Preço inválido, ex.: 59,90';
  if (!f.listingType) errors.listingType = 'Sem tipo de anúncio com taxa cadastrada';
  if (f.marketplaceCategory.trim() && !/^[A-Za-z0-9_-]{1,60}$/.test(f.marketplaceCategory.trim()))
    errors.marketplaceCategory = 'Use o código do canal (ex.: MLB1234)';
  return errors;
}

/** Aviso do Mercado Livre: acima de R$ 79 o frete grátis é obrigatório. */
export function freeShippingWarning(provider: Provider, f: ChannelForm): string | null {
  const price = parseBRL(f.price);
  if (provider !== 'mercadolivre' || price === null) return null;
  return price >= ML_FREE_SHIPPING_FROM_CENTS && !f.freeShipping
    ? 'No Mercado Livre, produtos a partir de R$ 79 têm frete grátis obrigatório (o custo é seu).'
    : null;
}

const messages: Record<string, string> = {
  'products.not_found': 'Produto não encontrado ou sem permissão.',
  'channels.sellers_only': 'Configuração de canais é exclusiva de vendedores.',
  'channels.invalid': 'Dados inválidos. Revise os campos.',
  'channels.title_too_long': 'Título acima do limite do canal.',
  'channels.save_first': 'Salve a configuração do Mercado Livre antes.',
  'channels.listing_type_unavailable':
    'Tipo de anúncio sem taxa cadastrada. A equipe TheSigns cadastra em Taxas e comissões.',
};

export function channelErrorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && messages[message]) return messages[message];
  return 'Não foi possível salvar. Tente de novo.';
}
