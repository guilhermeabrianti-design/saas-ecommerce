import { z } from 'zod';

/** Canais suportados: Mercado Livre, Shopee e TikTok Shop. */
export const providers = ['mercadolivre', 'shopee', 'tiktok'] as const;
export type Provider = (typeof providers)[number];

export const providerLabels: Record<Provider, string> = {
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

export const linkFormSchema = z.object({
  inventoryItemId: z.uuid('Escolha um item de estoque'),
  externalId: z.string().trim().min(1, 'Informe o SKU do marketplace').max(120, 'Máximo de 120'),
  syncStock: z.boolean(),
});
export type LinkFormValues = z.infer<typeof linkFormSchema>;
