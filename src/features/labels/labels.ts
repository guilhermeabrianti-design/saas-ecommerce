import { z } from 'zod';

export const LABEL_MAX_BYTES = 5 * 1024 * 1024;
export const LABEL_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

export const labelSchema = z.object({
  id: z.uuid(),
  supplier_order_id: z.uuid().nullable(),
  order_id: z.uuid().nullable(),
  storage_path: z.string(),
  file_name: z.string(),
  carrier: z.string().nullable(),
  tracking_code: z.string().nullable(),
  uploaded_org_id: z.uuid().nullable(),
  voided_at: z.string().nullable(),
  created_at: z.string(),
});

export type ShippingLabel = z.infer<typeof labelSchema>;

export interface Shipment {
  supplierOrderId: string | null;
  orderId: string | null;
}

/** Pasta do envio no bucket (a mesma que o banco confere). */
export const shipmentFolder = (s: Shipment) =>
  s.supplierOrderId ? `so-${s.supplierOrderId}` : `o-${s.orderId}`;

/** Confere o arquivo antes de enviar: tipo e tamanho aceitos pelo bucket. */
export function checkLabelFile(file: { type: string; size: number }): string | null {
  if (!LABEL_TYPES[file.type]) return 'Envie PDF, PNG ou JPG.';
  if (file.size > LABEL_MAX_BYTES) return 'Arquivo acima de 5 MB.';
  if (file.size === 0) return 'Arquivo vazio.';
  return null;
}

export const labelPath = (s: Shipment, type: string, id: string = crypto.randomUUID()) =>
  `${shipmentFolder(s)}/${id}.${LABEL_TYPES[type] ?? 'bin'}`;

/** Etiqueta ativa mais recente com rastreio (para preencher o envio). */
export function latestTracking(labels: ShippingLabel[]) {
  return (
    [...labels]
      .filter((l) => !l.voided_at && l.tracking_code)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
  );
}

const messages: Record<string, string> = {
  'labels.not_found': 'Envio não encontrado ou sem permissão.',
  'labels.file_missing': 'O arquivo não chegou ao armazenamento. Tente enviar de novo.',
  'labels.shipment_closed': 'Este envio já foi encerrado (cancelado ou entregue).',
  rate_limited: 'Muitas operações seguidas. Aguarde um pouco.',
};

export function labelErrorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && messages[message]) return messages[message];
  if (typeof message === 'string' && /row-level security|mime|size/i.test(message))
    return 'Arquivo recusado: envie PDF, PNG ou JPG de até 5 MB.';
  return 'Não foi possível concluir. Tente de novo.';
}
