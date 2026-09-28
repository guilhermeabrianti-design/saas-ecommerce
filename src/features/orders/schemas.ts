import { z } from 'zod';
import { isValidDocument, onlyDigits, UFS } from '@/utils/br';
import { parseBRL } from '@/utils/money';

export const orderStatuses = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof orderStatuses)[number];

export const orderStatusLabels: Record<OrderStatus, string> = {
  pending: 'Pendente',
  confirmed: 'Confirmado',
  shipped: 'Enviado',
  delivered: 'Entregue',
  cancelled: 'Cancelado',
};

export const orderChannels = ['manual', 'marketplace', 'checkout'] as const;
export type OrderChannel = (typeof orderChannels)[number];

export const orderChannelLabels: Record<OrderChannel, string> = {
  manual: 'Manual',
  marketplace: 'Marketplace',
  checkout: 'Checkout',
};

/** Pedido do checkout ainda sem pagamento aparece como "Aguardando pagamento". */
export function orderStatusLabel(status: OrderStatus, channel: OrderChannel): string {
  return channel === 'checkout' && status === 'pending'
    ? 'Aguardando pagamento'
    : orderStatusLabels[status];
}

export const supplierOrderStatuses = ['pending', 'shipped', 'cancelled'] as const;
export type SupplierOrderStatus = (typeof supplierOrderStatuses)[number];

export const supplierOrderStatusLabels: Record<SupplierOrderStatus, string> = {
  pending: 'Aguardando envio',
  shipped: 'Enviado',
  cancelled: 'Cancelado',
};

const optionalMoney = z
  .string()
  .trim()
  .refine((v) => v === '' || parseBRL(v) !== null, { error: 'Valor inválido, ex.: 15,00' });

export const orderItemFormSchema = z.object({
  inventoryItemId: z.uuid(),
  label: z.string(),
  defaultPriceCents: z.number().int(),
  available: z.number().int(),
  isDropship: z.boolean(),
  quantity: z
    .string()
    .trim()
    .refine((v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 10_000, {
      error: 'De 1 a 10.000',
    }),
  unitPrice: optionalMoney,
});

/** Mirrors the `orders` check constraints and `create_order` validation. */
export const orderFormSchema = z
  .object({
    customerName: z.string().trim().min(2, 'Informe o nome').max(120, 'Máximo de 120 caracteres'),
    customerEmail: z
      .string()
      .trim()
      .refine((v) => v === '' || z.email().safeParse(v).success, { error: 'E-mail inválido' }),
    customerPhone: z.string().refine((v) => v.trim() === '' || /^\d{10,13}$/.test(onlyDigits(v)), {
      error: 'Telefone com DDD, ex.: (11) 98765-4321',
    }),
    customerDocument: z
      .string()
      .refine((v) => v.trim() === '' || isValidDocument(v), { error: 'CPF ou CNPJ inválido' }),
    postalCode: z
      .string()
      .refine((v) => onlyDigits(v).length === 8, { error: 'CEP com 8 dígitos' }),
    street: z.string().trim().min(2, 'Informe a rua').max(200),
    number: z.string().trim().min(1, 'Informe o número').max(20),
    complement: z.string().trim().max(100),
    district: z.string().trim().min(2, 'Informe o bairro').max(100),
    city: z.string().trim().min(2, 'Informe a cidade').max(100),
    state: z.enum(UFS, { error: 'Escolha a UF' }),
    shipping: optionalMoney,
    discount: optionalMoney,
    notes: z.string().trim().max(1000, 'Máximo de 1.000 caracteres'),
    items: z.array(orderItemFormSchema).min(1, 'Adicione ao menos um item').max(100),
  })
  .superRefine((v, ctx) => {
    const total = orderTotals(v);
    if (total && total.total < 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['discount'],
        message: 'Desconto maior que o valor do pedido',
      });
    }
  });

export type OrderFormValues = z.infer<typeof orderFormSchema>;
export type OrderItemFormValues = z.infer<typeof orderItemFormSchema>;

const cents = (v: string) => (v.trim() === '' ? 0 : parseBRL(v));

/** Totals as the database will compute them; null while some value is invalid. */
export function orderTotals(v: Pick<OrderFormValues, 'items' | 'shipping' | 'discount'>) {
  let subtotal = 0;
  for (const item of v.items) {
    const qty = Number(item.quantity);
    const price = item.unitPrice.trim() === '' ? item.defaultPriceCents : parseBRL(item.unitPrice);
    if (!Number.isInteger(qty) || qty < 1 || price === null) return null;
    subtotal += qty * price;
  }
  const shipping = cents(v.shipping);
  const discount = cents(v.discount);
  if (shipping === null || discount === null) return null;
  return { subtotal, shipping, discount, total: subtotal + shipping - discount };
}

/** JSON accepted by `create_order` (call only with values that passed the schema). */
export function toOrderPayload(v: OrderFormValues) {
  const nullable = (s: string) => (s.trim() === '' ? null : s.trim());
  return {
    customer_name: v.customerName.trim(),
    customer_email: nullable(v.customerEmail),
    customer_phone: nullable(onlyDigits(v.customerPhone)),
    customer_document: nullable(onlyDigits(v.customerDocument)),
    ship_postal_code: onlyDigits(v.postalCode),
    ship_street: v.street.trim(),
    ship_number: v.number.trim(),
    ship_complement: nullable(v.complement),
    ship_district: v.district.trim(),
    ship_city: v.city.trim(),
    ship_state: v.state,
    shipping_cents: cents(v.shipping) ?? 0,
    discount_cents: cents(v.discount) ?? 0,
    notes: nullable(v.notes),
    items: v.items.map((i) => ({
      inventory_item_id: i.inventoryItemId,
      quantity: Number(i.quantity),
      ...(i.unitPrice.trim() === '' ? {} : { unit_price_cents: parseBRL(i.unitPrice) }),
    })),
  };
}

export const emptyOrderForm: OrderFormValues = {
  customerName: '',
  customerEmail: '',
  customerPhone: '',
  customerDocument: '',
  postalCode: '',
  street: '',
  number: '',
  complement: '',
  district: '',
  city: '',
  state: '' as OrderFormValues['state'],
  shipping: '',
  discount: '',
  notes: '',
  items: [],
};

/**
 * "Em trânsito" (Fase 30): derivado do envio com rastreio e sem entrega.
 * O status automático por evento da transportadora depende da API dela.
 */
export function inTransit(order: {
  status: OrderStatus;
  supplier_orders: { status: SupplierOrderStatus; tracking_code: string | null }[];
}): boolean {
  if (order.status === 'shipped') return true;
  return (
    order.status === 'confirmed' &&
    order.supplier_orders.some((s) => s.status === 'shipped' && s.tracking_code)
  );
}
