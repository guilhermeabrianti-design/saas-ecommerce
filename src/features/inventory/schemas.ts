import { z } from 'zod';

export const inventoryReasons = ['purchase', 'return', 'adjustment', 'loss', 'count'] as const;
export type InventoryReason = (typeof inventoryReasons)[number];

export const reasonLabels: Record<InventoryReason, string> = {
  purchase: 'Entrada (compra)',
  return: 'Devolução',
  adjustment: 'Ajuste',
  loss: 'Perda / avaria',
  count: 'Contagem de inventário',
};

/** What the person picks in the form; each maps to one RPC call shape. */
export const stockModes = ['purchase', 'return', 'loss', 'adjustment', 'count'] as const;
export type StockMode = (typeof stockModes)[number];

export const stockModeHints: Record<StockMode, string> = {
  purchase: 'Quantidade que entrou.',
  return: 'Quantidade devolvida ao estoque.',
  loss: 'Quantidade perdida ou avariada (sai do estoque).',
  adjustment: 'Use sinal: 5 soma, -5 subtrai.',
  count: 'Quantidade física contada. O sistema registra a diferença.',
};

const MAX_DELTA = 1_000_000;
const MAX_ON_HAND = 1_000_000_000;

/** Mirrors the checks in `adjust_stock` / `set_stock`. */
export const stockFormSchema = z
  .object({
    mode: z.enum(stockModes),
    quantity: z.string().trim(),
    note: z.string().trim().max(500, 'Use no máximo 500 caracteres'),
  })
  .superRefine(({ mode, quantity }, ctx) => {
    const signed = mode === 'adjustment';
    const pattern = signed ? /^[+-]?\d+$/ : /^\d+$/;
    const n = Number(quantity);
    const issue = (message: string) =>
      ctx.addIssue({ code: 'custom', path: ['quantity'], message });

    if (!pattern.test(quantity)) {
      issue(signed ? 'Informe um número inteiro, ex.: 5 ou -5' : 'Informe um número inteiro');
    } else if (mode === 'count') {
      if (n > MAX_ON_HAND) issue('Quantidade alta demais');
    } else if (n === 0) {
      issue('A quantidade não pode ser zero');
    } else if (Math.abs(n) > MAX_DELTA) {
      issue(`Movimente no máximo ${MAX_DELTA.toLocaleString('pt-BR')} unidades por vez`);
    }
  });

export type StockFormValues = z.infer<typeof stockFormSchema>;

export type StockRequest =
  | { kind: 'adjust'; delta: number; reason: Exclude<InventoryReason, 'count'>; note: string }
  | { kind: 'set'; quantity: number; note: string };

/** Call only with values that passed `stockFormSchema`. */
export function toStockRequest({ mode, quantity, note }: StockFormValues): StockRequest {
  const n = Number(quantity);
  if (mode === 'count') return { kind: 'set', quantity: n, note };
  return { kind: 'adjust', delta: mode === 'loss' ? -n : n, reason: mode, note };
}

/** Available quantity after the movement, or null when it can't be known ahead. */
export function previewOnHand(onHand: number, values: StockFormValues): number | null {
  const parsed = stockFormSchema.safeParse(values);
  if (!parsed.success) return null;
  const req = toStockRequest(parsed.data);
  return req.kind === 'set' ? req.quantity : onHand + req.delta;
}
