import { z } from 'zod';

export const LABEL_MAX_BYTES = 5 * 1024 * 1024;
export const LABEL_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/xml': 'xml',
  'text/xml': 'xml',
};

export const documentKinds = ['label', 'invoice_pdf', 'invoice_xml'] as const;
export type DocumentKind = (typeof documentKinds)[number];

export const documentKindLabels: Record<DocumentKind, string> = {
  label: 'Etiqueta',
  invoice_pdf: 'Nota fiscal (DANFE)',
  invoice_xml: 'Nota fiscal (XML)',
};

/** Tipos de arquivo aceitos por documento (o banco e o bucket conferem de novo). */
const KIND_TYPES: Record<DocumentKind, string[]> = {
  label: ['application/pdf', 'image/png', 'image/jpeg'],
  invoice_pdf: ['application/pdf'],
  invoice_xml: ['application/xml', 'text/xml'],
};

export const acceptFor = (kind: DocumentKind) =>
  kind === 'invoice_xml' ? 'application/xml,text/xml,.xml' : KIND_TYPES[kind].join(',');

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
  kind: z.enum(documentKinds),
  source: z.enum(['upload', 'mercadolivre']),
});

export type ShippingLabel = z.infer<typeof labelSchema>;

export interface Shipment {
  supplierOrderId: string | null;
  orderId: string | null;
}

/** Pasta do envio no bucket (a mesma que o banco confere). */
export const shipmentFolder = (s: Shipment) =>
  s.supplierOrderId ? `so-${s.supplierOrderId}` : `o-${s.orderId}`;

/**
 * Tipo do arquivo: o navegador às vezes não informa o de XML (vazio);
 * nesse caso vale a extensão.
 */
export function fileType(file: { type: string; name?: string }): string {
  if (file.type) return file.type;
  return file.name?.toLowerCase().endsWith('.xml') ? 'application/xml' : '';
}

/** Confere o arquivo antes de enviar: tipo do documento e tamanho aceitos pelo bucket. */
export function checkLabelFile(
  file: { type: string; size: number; name?: string },
  kind: DocumentKind = 'label',
): string | null {
  if (!KIND_TYPES[kind].includes(fileType(file))) {
    return kind === 'label'
      ? 'Envie PDF, PNG ou JPG.'
      : kind === 'invoice_pdf'
        ? 'Envie o DANFE em PDF.'
        : 'Envie o XML da nota.';
  }
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
  'labels.invalid': 'Tipo de documento inválido.',
  rate_limited: 'Muitas operações seguidas. Aguarde um pouco.',
};

export function labelErrorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && messages[message]) return messages[message];
  if (typeof message === 'string' && /row-level security|mime|size/i.test(message))
    return 'Arquivo recusado: envie PDF, PNG, JPG ou XML de até 5 MB.';
  return 'Não foi possível concluir. Tente de novo.';
}

/** Resposta da Edge Function ao buscar documentos no Mercado Livre. */
export function mlDocumentsMessage(
  result: { status?: string; attached?: string[]; skipped?: string } | null,
): string {
  if (!result) return 'Nada novo no Mercado Livre.';
  if (result.skipped) return `Mercado Livre: ${result.skipped}.`;
  if (result.status === 'pending')
    return 'O pedido ainda está pendente: confirme-o para enviar ao fornecedor.';
  const n = result.attached?.length ?? 0;
  if (n === 0)
    return 'Nenhum documento novo. A etiqueta sai quando o envio fica pronto e a nota quando é autorizada no Mercado Livre.';
  return `${n} documento${n > 1 ? 's' : ''} anexado${n > 1 ? 's' : ''}.`;
}

const mlErrors: Record<string, string> = {
  not_configured: 'Integração com o Mercado Livre não configurada na plataforma.',
  not_mercadolivre: 'Este pedido não veio do Mercado Livre.',
  rate_limited: 'Muitas buscas seguidas. Aguarde alguns minutos.',
  forbidden: 'Sem permissão para este pedido.',
  provider_unavailable: 'O Mercado Livre não respondeu. Tente de novo em instantes.',
};

export const mlDocumentsErrorMessage = (code: string | null) =>
  (code && mlErrors[code]) || 'Não foi possível buscar no Mercado Livre. Tente de novo.';
