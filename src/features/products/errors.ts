import { orgErrorMessage } from '@/features/organizations/errors';

/** Product errors first (unique SKU, delete rule), then the shared tenant errors. */
export function productErrorMessage(error: unknown): string {
  const { message, code } = (error ?? {}) as { message?: unknown; code?: unknown };
  if (code === '23505') return 'Já existe um produto com este SKU nesta organização.';
  if (message === 'products.delete_not_draft') {
    return 'Só rascunhos podem ser excluídos. Arquive o produto em vez disso.';
  }
  return orgErrorMessage(error);
}
