import { z } from 'zod';

export const providers = ['shopify', 'woocommerce', 'mercadolivre', 'shopee', 'tiktok'] as const;
export type Provider = (typeof providers)[number];

/** Conectáveis hoje; os demais aparecem como "em breve". */
export const connectableProviders = ['shopify', 'woocommerce'] as const;
export type ConnectableProvider = (typeof connectableProviders)[number];

export const providerLabels: Record<Provider, string> = {
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
  mercadolivre: 'Mercado Livre',
  shopee: 'Shopee',
  tiktok: 'TikTok Shop',
};

export const connectionStatuses = ['active', 'paused', 'disconnected'] as const;
export type ConnectionStatus = (typeof connectionStatuses)[number];

export const connectionStatusLabels: Record<ConnectionStatus, string> = {
  active: 'Ativa',
  paused: 'Pausada',
  disconnected: 'Desconectada',
};

export const eventStatuses = ['ok', 'error', 'skipped'] as const;

/** Onde o vendedor encontra o identificador da conta em cada provedor. */
export const accountHints: Record<ConnectableProvider, { label: string; placeholder: string }> = {
  shopify: { label: 'Domínio da loja', placeholder: 'minha-loja.myshopify.com' },
  woocommerce: { label: 'Endereço da loja', placeholder: 'https://minhaloja.com.br' },
};

/** Instruções curtas para configurar o webhook no provedor. */
export const webhookInstructions: Record<ConnectableProvider, string[]> = {
  shopify: [
    'No admin da Shopify: Configurações → Notificações → Webhooks → Criar webhook.',
    'Evento: "Criação de pedido" (orders/create) e, se quiser, "Pagamento de pedido" (orders/paid). Formato: JSON.',
    'URL: a mostrada abaixo. Cole aqui o segredo de assinatura que a Shopify exibe no fim da página de webhooks.',
  ],
  woocommerce: [
    'No WordPress: WooCommerce → Configurações → Avançado → Webhooks → Adicionar webhook.',
    'Tópicos: "Pedido criado" e "Pedido atualizado". Status: Ativo.',
    'URL de entrega: a mostrada abaixo. Segredo: o mesmo valor cadastrado aqui.',
  ],
};

export const connectionFormSchema = z.object({
  provider: z.enum(connectableProviders),
  name: z.string().trim().min(2, 'Informe um nome').max(80, 'Máximo de 80 caracteres'),
  externalAccountId: z
    .string()
    .trim()
    .min(3, 'Informe o endereço da loja')
    .max(200, 'Máximo de 200 caracteres'),
  secret: z
    .string()
    .trim()
    .min(16, 'O segredo precisa ter ao menos 16 caracteres')
    .max(200, 'Máximo de 200 caracteres'),
});
export type ConnectionFormValues = z.infer<typeof connectionFormSchema>;

export const emptyConnectionForm: ConnectionFormValues = {
  provider: 'shopify',
  name: '',
  externalAccountId: '',
  secret: '',
};

export const linkFormSchema = z.object({
  inventoryItemId: z.uuid('Escolha um item de estoque'),
  externalId: z.string().trim().min(1, 'Informe o SKU do marketplace').max(120, 'Máximo de 120'),
  syncStock: z.boolean(),
});
export type LinkFormValues = z.infer<typeof linkFormSchema>;

/** URL que o vendedor cadastra no provedor. */
export function webhookUrl(supabaseUrl: string | undefined, provider: Provider, id: string) {
  const base = (supabaseUrl ?? '').replace(/\/+$/, '');
  return `${base || '<URL-do-projeto-Supabase>'}/functions/v1/webhooks/${provider}/${id}`;
}

/** Segredo aleatório de 48 caracteres hexadecimais (para provedores em que o vendedor o define). */
export function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const credentialText = (label: string) =>
  z
    .string()
    .trim()
    .min(10, `${label}: ao menos 10 caracteres`)
    .max(300, `${label}: máximo de 300 caracteres`);

export const shopifyCredentialsSchema = z.object({
  accessToken: credentialText('Token'),
  locationId: z
    .string()
    .trim()
    .refine((v) => /^(gid:\/\/shopify\/Location\/)?\d{1,20}$/.test(v), {
      error: 'Informe o número do local de estoque',
    }),
});
export type ShopifyCredentialsValues = z.infer<typeof shopifyCredentialsSchema>;

export const wooCredentialsSchema = z.object({
  consumerKey: credentialText('Consumer key'),
  consumerSecret: credentialText('Consumer secret'),
});
export type WooCredentialsValues = z.infer<typeof wooCredentialsSchema>;
