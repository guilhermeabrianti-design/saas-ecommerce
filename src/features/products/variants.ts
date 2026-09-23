import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import { centsToInput, parseBRL } from '@/utils/money';
import { productKeys } from './api';
import { isValidGtin } from './schemas';

export const MAX_VARIANT_ATTRIBUTES = 3;

const variantSchema = z.object({
  id: z.uuid(),
  sku: z.string(),
  attributes: z.record(z.string(), z.string()),
  price_cents: z.number().int().nullable(),
  gtin: z.string().nullable(),
  weight_grams: z.number().int().nullable(),
  is_active: z.boolean(),
});

export type Variant = z.infer<typeof variantSchema>;

const variantKeys = {
  list: (orgId: string, productId: string) =>
    [...productKeys.all(orgId), 'variants', productId] as const,
};

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

const attributeRow = z.object({ name: z.string().trim(), value: z.string().trim() });

/** Mirrors `private.valid_variant_attributes` and the product_variants checks. */
export const variantFormSchema = z
  .object({
    sku: z
      .string()
      .trim()
      .min(1, 'Informe o SKU')
      .max(60, 'Use no máximo 60 caracteres')
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use letras, números, ponto, hífen ou sublinhado'),
    attributes: z.array(attributeRow).max(MAX_VARIANT_ATTRIBUTES),
    price: z
      .string()
      .trim()
      .refine((v) => v === '' || parseBRL(v) !== null, { error: 'Valor inválido, ex.: 49,90' }),
    gtin: z
      .string()
      .trim()
      .refine((v) => v === '' || isValidGtin(v), { error: 'GTIN/EAN inválido' }),
    weightGrams: z
      .string()
      .trim()
      .refine((v) => v === '' || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 1_000_000), {
        error: 'Inteiro entre 1 e 1.000.000 g',
      }),
  })
  .superRefine((values, ctx) => {
    const filled = values.attributes.filter((a) => a.name || a.value);
    if (filled.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['attributes'],
        message: 'Informe ao menos um atributo, ex.: Cor = Azul',
      });
    }
    const names = new Set<string>();
    values.attributes.forEach((a, i) => {
      if (!a.name && !a.value) return;
      if (!a.name || a.name.length > 30) {
        ctx.addIssue({
          code: 'custom',
          path: ['attributes', i, 'name'],
          message: 'Nome com 1 a 30 caracteres',
        });
      }
      if (!a.value || a.value.length > 50) {
        ctx.addIssue({
          code: 'custom',
          path: ['attributes', i, 'value'],
          message: 'Valor com 1 a 50 caracteres',
        });
      }
      const key = a.name.toLowerCase();
      if (names.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['attributes', i, 'name'],
          message: 'Atributo repetido',
        });
      }
      names.add(key);
    });
  });

export type VariantFormValues = z.infer<typeof variantFormSchema>;

export const emptyVariantForm = (attributeNames: string[] = []): VariantFormValues => ({
  sku: '',
  attributes: (attributeNames.length ? attributeNames : ['']).map((name) => ({ name, value: '' })),
  price: '',
  gtin: '',
  weightGrams: '',
});

export function toVariantFormValues(v: Variant): VariantFormValues {
  return {
    sku: v.sku,
    attributes: Object.entries(v.attributes).map(([name, value]) => ({ name, value })),
    price: centsToInput(v.price_cents),
    gtin: v.gtin ?? '',
    weightGrams: v.weight_grams == null ? '' : String(v.weight_grams),
  };
}

export interface VariantPayload {
  sku: string;
  attributes: Record<string, string>;
  price_cents: number | null;
  gtin: string | null;
  weight_grams: number | null;
}

/** Call only with values that passed `variantFormSchema`. */
export function toVariantPayload(values: VariantFormValues): VariantPayload {
  return {
    sku: values.sku.trim(),
    attributes: Object.fromEntries(
      values.attributes
        .filter((a) => a.name.trim() && a.value.trim())
        .map((a) => [a.name.trim(), a.value.trim()]),
    ),
    price_cents: values.price.trim() === '' ? null : parseBRL(values.price),
    gtin: values.gtin.trim() === '' ? null : values.gtin.trim(),
    weight_grams: values.weightGrams.trim() === '' ? null : Number(values.weightGrams),
  };
}

export const describeAttributes = (attrs: Record<string, string>) =>
  Object.entries(attrs)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');

// ---------------------------------------------------------------------------
// Queries & mutations
// ---------------------------------------------------------------------------

export function useVariants(orgId: string, productId: string) {
  return useQuery({
    queryKey: variantKeys.list(orgId, productId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('product_variants')
        .select('id, sku, attributes, price_cents, gtin, weight_grams, is_active')
        .eq('organization_id', orgId)
        .eq('product_id', productId)
        .order('created_at');
      if (error) throw error;
      return z.array(variantSchema).parse(data);
    },
  });
}

function useInvalidateVariants(orgId: string, productId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: variantKeys.list(orgId, productId) });
}

/** Creates when `id` is null, updates otherwise. */
export function useSaveVariant(orgId: string, productId: string) {
  const invalidate = useInvalidateVariants(orgId, productId);
  return useMutation({
    mutationFn: async ({ id, payload }: { id: string | null; payload: VariantPayload }) => {
      const client = getSupabase().from('product_variants');
      const { data, error } = id
        ? await client.update(payload).eq('organization_id', orgId).eq('id', id).select('id')
        : await client
            .insert({ ...payload, organization_id: orgId, product_id: productId })
            .select('id');
      if (error) throw error;
      if (!data?.length) throw { message: 'org.forbidden' };
    },
    onSuccess: invalidate,
  });
}

export function useSetVariantActive(orgId: string, productId: string) {
  const invalidate = useInvalidateVariants(orgId, productId);
  return useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { data, error } = await getSupabase()
        .from('product_variants')
        .update({ is_active: active })
        .eq('organization_id', orgId)
        .eq('id', id)
        .select('id');
      if (error) throw error;
      if (!data?.length) throw { message: 'org.forbidden' };
    },
    onSettled: invalidate,
  });
}

export function useDeleteVariant(orgId: string, productId: string) {
  const invalidate = useInvalidateVariants(orgId, productId);
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await getSupabase()
        .from('product_variants')
        .delete()
        .eq('organization_id', orgId)
        .eq('id', id)
        .select('id');
      if (error) throw error;
      if (!data?.length) throw { message: 'products.variant_delete_not_draft' };
    },
    onSettled: invalidate,
  });
}
