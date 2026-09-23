import { productErrorMessage } from '@/features/products/errors';

const messages: Partial<Record<string, string>> = {
  'inventory.insufficient_stock': 'Estoque insuficiente: o saldo não pode ficar negativo.',
  'inventory.invalid_quantity': 'Quantidade inválida para este tipo de movimentação.',
  'inventory.item_not_found': 'Item de estoque não encontrado ou sem permissão para movimentar.',
  'inventory.use_variants': 'Este produto tem variações: movimente o estoque de cada variação.',
  'inventory.request_reused': 'Envio duplicado detectado. Atualize a página e tente de novo.',
};

/** Inventory errors first; product and tenant errors otherwise. */
export function inventoryErrorMessage(error: unknown): string {
  const { message } = (error ?? {}) as { message?: unknown };
  if (typeof message === 'string' && messages[message]) return messages[message];
  return productErrorMessage(error);
}
