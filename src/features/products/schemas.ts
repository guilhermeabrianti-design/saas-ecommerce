import { z } from 'zod';
import { centsToInput, parseBRL } from '@/utils/money';

export const productStatuses = ['draft', 'active', 'archived'] as const;
export type ProductStatus = (typeof productStatuses)[number];

export const productStatusLabels: Record<ProductStatus, string> = {
  draft: 'Rascunho',
  active: 'Ativo',
  archived: 'Arquivado',
};

/** GS1 mod-10 check digit, valid for EAN-8, UPC-A, EAN-13 and GTIN-14. */
export function isValidGtin(code: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

const MAX_CENTS = 100_000_000_000;

const money = (required: boolean) =>
  z
    .string()
    .trim()
    .refine((v) => (v === '' ? !required : parseBRL(v) !== null), {
      error: required ? 'Informe um valor, ex.: 49,90' : 'Valor inválido, ex.: 49,90',
    })
    .refine((v) => v === '' || (parseBRL(v) ?? 0) <= MAX_CENTS, { error: 'Valor alto demais' });

const positiveInt = (max: number, unit: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === '' || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= max), {
      error: `Inteiro entre 1 e ${max.toLocaleString('pt-BR')} ${unit}`,
    });

/** Form values are strings (what inputs hold); `toProductPayload` converts them. */
export const productFormSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome').max(200, 'Use no máximo 200 caracteres'),
  sku: z
    .string()
    .trim()
    .min(1, 'Informe o SKU')
    .max(60, 'Use no máximo 60 caracteres')
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use letras, números, ponto, hífen ou sublinhado'),
  brand: z.string().trim().max(80, 'Use no máximo 80 caracteres'),
  gtin: z
    .string()
    .trim()
    .refine((v) => v === '' || isValidGtin(v), { error: 'GTIN/EAN inválido (confira os dígitos)' }),
  description: z.string().max(5000, 'Use no máximo 5.000 caracteres'),
  price: money(true),
  cost: money(false),
  weightGrams: positiveInt(1_000_000, 'g'),
  lengthMm: positiveInt(10_000, 'mm'),
  widthMm: positiveInt(10_000, 'mm'),
  heightMm: positiveInt(10_000, 'mm'),
  status: z.enum(productStatuses),
});

export type ProductFormValues = z.infer<typeof productFormSchema>;

/** Columns the client may write (mirrors the column grants in the migration). */
export interface ProductPayload {
  sku: string;
  name: string;
  description: string;
  brand: string | null;
  gtin: string | null;
  price_cents: number;
  cost_cents: number | null;
  weight_grams: number | null;
  length_mm: number | null;
  width_mm: number | null;
  height_mm: number | null;
  status: ProductStatus;
}

const optionalInt = (v: string) => (v.trim() === '' ? null : Number(v));
const optionalText = (v: string) => (v.trim() === '' ? null : v.trim());

/** Call only with values that passed `productFormSchema`. */
export function toProductPayload(values: ProductFormValues): ProductPayload {
  return {
    sku: values.sku.trim(),
    name: values.name.trim(),
    description: values.description.trim(),
    brand: optionalText(values.brand),
    gtin: optionalText(values.gtin),
    price_cents: parseBRL(values.price)!,
    cost_cents: values.cost.trim() === '' ? null : parseBRL(values.cost),
    weight_grams: optionalInt(values.weightGrams),
    length_mm: optionalInt(values.lengthMm),
    width_mm: optionalInt(values.widthMm),
    height_mm: optionalInt(values.heightMm),
    status: values.status,
  };
}

export function toProductFormValues(p: ProductPayload): ProductFormValues {
  const int = (n: number | null) => (n == null ? '' : String(n));
  return {
    name: p.name,
    sku: p.sku,
    brand: p.brand ?? '',
    gtin: p.gtin ?? '',
    description: p.description,
    price: centsToInput(p.price_cents),
    cost: centsToInput(p.cost_cents),
    weightGrams: int(p.weight_grams),
    lengthMm: int(p.length_mm),
    widthMm: int(p.width_mm),
    heightMm: int(p.height_mm),
    status: p.status,
  };
}

export const emptyProductForm: ProductFormValues = {
  name: '',
  sku: '',
  brand: '',
  gtin: '',
  description: '',
  price: '',
  cost: '',
  weightGrams: '',
  lengthMm: '',
  widthMm: '',
  heightMm: '',
  status: 'draft',
};
