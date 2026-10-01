import { orgErrorMessage } from '@/features/organizations/errors';

const messages: Partial<Record<string, string>> = {
  'products.sku_taken': 'Este SKU já está em uso por outro produto ou variação desta empresa.',
  'products.delete_not_draft': 'Só rascunhos podem ser excluídos. Arquive o produto em vez disso.',
  'products.variant_delete_not_draft':
    'Variações só podem ser excluídas enquanto o produto é rascunho. Desative-a em vez disso.',
  'products.image_limit': 'Limite de 10 imagens por produto.',
  'products.invalid_image_order': 'A lista de imagens mudou. Atualize a página e tente de novo.',
  'inventory.product_has_stock':
    'Zere o estoque do produto antes de criar variações (o saldo passa a ser por variação).',
  'inventory.ledger_immutable':
    'Este item tem histórico de estoque e não pode ser excluído. Arquive o produto ou desative a variação.',
};

/** Product errors first (SKU, delete rules, images), then the shared tenant errors. */
export function productErrorMessage(error: unknown): string {
  const { message, code } = (error ?? {}) as { message?: unknown; code?: unknown };
  if (typeof message === 'string' && messages[message]) return messages[message];
  if (code === '23505') {
    if (typeof message === 'string' && message.includes('attributes')) {
      return 'Já existe uma variação com esses atributos neste produto.';
    }
    return messages['products.sku_taken']!;
  }
  return orgErrorMessage(error);
}
