import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import {
  fileType,
  labelPath,
  labelSchema,
  mlDocumentsErrorMessage,
  mlDocumentsMessage,
  type DocumentKind,
  type Shipment,
} from './labels';

const BUCKET = 'shipping-labels';

export const labelKeys = {
  all: ['shipping-labels'] as const,
  shipment: (s: Shipment) => ['shipping-labels', s.supplierOrderId ?? s.orderId] as const,
};

export function useShippingLabels(s: Shipment) {
  return useQuery({
    queryKey: labelKeys.shipment(s),
    queryFn: async () => {
      let query = getSupabase()
        .from('shipping_labels')
        .select(
          'id, supplier_order_id, order_id, storage_path, file_name, carrier, tracking_code, uploaded_org_id, voided_at, created_at, kind, source',
        )
        .order('created_at', { ascending: false });
      query = s.supplierOrderId
        ? query.eq('supplier_order_id', s.supplierOrderId)
        : query.eq('order_id', s.orderId!);
      const { data, error } = await query;
      if (error) throw error;
      return z.array(labelSchema).parse(data);
    },
  });
}

/** Envia o arquivo à pasta do envio e registra (o banco confere a pasta e o acesso). */
export function useUploadLabel(s: Shipment) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      file: File;
      kind: DocumentKind;
      carrier: string;
      trackingCode: string;
    }) => {
      const type = fileType(input.file);
      const path = labelPath(s, type);
      const client = getSupabase();
      const up = await client.storage
        .from(BUCKET)
        .upload(path, input.file, { contentType: type, upsert: false });
      if (up.error) throw up.error;
      const isLabel = input.kind === 'label';
      const { error } = await client.rpc('register_shipping_label', {
        p_supplier_order: s.supplierOrderId,
        p_order: s.orderId,
        p_path: path,
        p_file_name: input.file.name.slice(0, 120),
        p_carrier: (isLabel && input.carrier.trim()) || null,
        p_tracking_code: (isLabel && input.trackingCode.trim()) || null,
        p_kind: input.kind,
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: labelKeys.shipment(s) }),
  });
}

export function useVoidLabel(s: Shipment) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await getSupabase().rpc('void_shipping_label', { p_label: id });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: labelKeys.shipment(s) }),
  });
}

/** Relê o pedido no Mercado Livre e anexa etiqueta e nota disponíveis. Devolve o resumo. */
export function useFetchMlDocuments(orderId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await getSupabase().functions.invoke('mercadolivre/documents', {
        body: { order_id: orderId },
      });
      if (error) {
        let code: string | null = null;
        if (error instanceof FunctionsHttpError) {
          code =
            ((await error.context.json().catch(() => null)) as { error?: string } | null)?.error ??
            null;
        }
        throw { message: mlDocumentsErrorMessage(code) };
      }
      return mlDocumentsMessage(data as Parameters<typeof mlDocumentsMessage>[0]);
    },
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

/** Link de download de 1 minuto (o bucket é privado). */
export async function labelDownloadUrl(path: string): Promise<string> {
  const { data, error } = await getSupabase().storage.from(BUCKET).createSignedUrl(path, 60);
  if (error || !data) throw error ?? new Error('signed url');
  return data.signedUrl;
}
