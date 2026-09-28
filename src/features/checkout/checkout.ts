import { z } from 'zod';
import { commissionSourceLabels } from '@/features/fees/fees';
import { UFS, isValidCpf, isValidPhone, onlyDigits } from '@/utils/br';

/** Origem da comissão (texto da Fase 15); origem desconhecida aparece como veio. */
export const commissionSourceLabel = (source: string) =>
  (commissionSourceLabels as Record<string, string>)[source] ?? source;

// ---------------------------------------------------------------------
// Oferta pública
// ---------------------------------------------------------------------

export const offerVariantSchema = z.object({
  variant_id: z.uuid(),
  attributes: z.record(z.string(), z.string()),
  price_cents: z.number().int(),
  available: z.number().int(),
});

export const offerSchema = z.object({
  offer: z.object({
    product_id: z.uuid(),
    name: z.string(),
    description: z.string(),
    brand: z.string().nullable(),
    store_name: z.string(),
    price_cents: z.number().int(),
    has_variants: z.boolean(),
    available: z.number().int().nullable(),
    variants: z.array(offerVariantSchema),
    images: z.array(z.string()),
    // Nota da loja (Fase 28).
    rating: z
      .object({ rating_avg: z.number().nullable(), rating_count: z.number().int() })
      .nullable()
      .optional(),
  }),
  payments: z.union([
    z.object({ configured: z.literal(true), public_key: z.string().min(1) }),
    z.object({ configured: z.literal(false) }),
  ]),
});

export type CheckoutOffer = z.infer<typeof offerSchema>;
export type OfferVariant = z.infer<typeof offerVariantSchema>;

/** Até 10 por pedido, limitado ao saldo do fornecedor. */
export const MAX_QUANTITY = 10;

export function maxQuantity(available: number | null | undefined): number {
  return Math.max(0, Math.min(MAX_QUANTITY, available ?? 0));
}

/** Preço e saldo da escolha atual (variação ou produto simples). */
export function selection(offer: CheckoutOffer['offer'], variantId: string | null) {
  if (offer.has_variants) {
    const v = offer.variants.find((x) => x.variant_id === variantId) ?? null;
    return { variant: v, price_cents: v?.price_cents ?? null, available: v?.available ?? 0 };
  }
  return { variant: null, price_cents: offer.price_cents, available: offer.available ?? 0 };
}

// ---------------------------------------------------------------------
// Comprador
// ---------------------------------------------------------------------

const required = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, `${label}: mínimo de ${min} caractere${min > 1 ? 's' : ''}`)
    .max(max, `${label}: máximo de ${max} caracteres`);

export const buyerSchema = z.object({
  customer_name: required('Nome', 2, 120),
  customer_email: z.string().trim().pipe(z.email('E-mail inválido')),
  customer_phone: z.string().refine(isValidPhone, 'Telefone com DDD, ex.: (11) 98765-4321'),
  customer_document: z.string().refine(isValidCpf, 'CPF inválido'),
  ship_postal_code: z.string().refine((v) => onlyDigits(v).length === 8, 'CEP com 8 dígitos'),
  ship_street: required('Rua', 2, 200),
  ship_number: required('Número', 1, 20),
  ship_complement: z.string().trim().max(100, 'Máximo de 100 caracteres'),
  ship_district: required('Bairro', 2, 100),
  ship_city: required('Cidade', 2, 100),
  ship_state: z.enum(UFS, 'Escolha o estado'),
});

export type BuyerValues = z.infer<typeof buyerSchema>;

export const emptyBuyer: BuyerValues = {
  customer_name: '',
  customer_email: '',
  customer_phone: '',
  customer_document: '',
  ship_postal_code: '',
  ship_street: '',
  ship_number: '',
  ship_complement: '',
  ship_district: '',
  ship_city: '',
  ship_state: 'SP',
};

/** O que vai para a Edge Function (só dígitos nos documentos). */
export function toBuyerPayload(v: BuyerValues) {
  return {
    ...v,
    customer_email: v.customer_email.toLowerCase(),
    customer_phone: onlyDigits(v.customer_phone),
    customer_document: onlyDigits(v.customer_document),
    ship_postal_code: onlyDigits(v.ship_postal_code),
  };
}

/**
 * Dados do Payment Brick → corpo do pagamento. Só o que o servidor aceita
 * (valor e dados do pagador vêm do pedido e do formulário, não do Brick).
 */
export function toPaymentPayload(formData: Record<string, unknown>) {
  const payment: Record<string, unknown> = { payment_method_id: formData.payment_method_id };
  if (formData.token) payment.token = formData.token;
  if (formData.installments != null) payment.installments = Number(formData.installments);
  if (formData.issuer_id != null && formData.issuer_id !== '')
    payment.issuer_id = String(formData.issuer_id);
  return payment;
}

// ---------------------------------------------------------------------
// Situação do pedido (comprador)
// ---------------------------------------------------------------------

export const paymentStatuses = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'refunded',
  'charged_back',
] as const;
export type CheckoutPaymentStatus = (typeof paymentStatuses)[number];

export const paymentStatusLabels: Record<CheckoutPaymentStatus, string> = {
  pending: 'Aguardando pagamento',
  approved: 'Pagamento aprovado',
  rejected: 'Pagamento recusado',
  cancelled: 'Pagamento cancelado ou vencido',
  refunded: 'Pagamento estornado',
  charged_back: 'Pagamento contestado',
};

export const checkoutMethodLabels = { pix: 'Pix', card: 'Cartão', boleto: 'Boleto' } as const;

export const orderStatusSchema = z.object({
  order_number: z.number().int(),
  store_name: z.string(),
  product_name: z.string().nullable(),
  total_cents: z.number().int(),
  payment_status: z.enum(paymentStatuses),
  order_status: z.enum(['pending', 'confirmed', 'shipped', 'delivered', 'cancelled']),
  method: z.enum(['pix', 'card', 'boleto']).nullable(),
  pix_qr_code: z.string().nullable(),
  pix_qr_base64: z.string().nullable(),
  boleto_url: z.string().nullable(),
  expires_at: z.string().nullable(),
  refund_pending: z.boolean(),
  tracking: z.array(z.object({ carrier: z.string().nullable(), code: z.string() })).nullable(),
  // Avaliação do comprador (Fase 28).
  can_review: z.boolean().optional().default(false),
  review: z
    .object({
      rating: z.number().int(),
      comment: z.string().nullable(),
      reply: z.string().nullable(),
    })
    .nullable()
    .optional(),
});

export type CheckoutOrderStatus = z.infer<typeof orderStatusSchema>;

/** Texto principal para o comprador, do mais urgente ao mais tranquilo. */
export function statusHeadline(s: CheckoutOrderStatus): string {
  if (s.refund_pending || (s.payment_status === 'approved' && s.order_status === 'cancelled')) {
    return 'Não foi possível separar o pedido: o valor será estornado.';
  }
  if (s.payment_status === 'approved') {
    return {
      pending: 'Pagamento aprovado. Estamos preparando o pedido.',
      confirmed: 'Pagamento aprovado. O pedido está em separação.',
      shipped: 'Pedido enviado.',
      delivered: 'Pedido entregue.',
      cancelled: 'Pedido cancelado.',
    }[s.order_status];
  }
  if (s.payment_status === 'pending') {
    return s.method === 'card'
      ? 'Pagamento em análise pelo emissor do cartão.'
      : 'Pedido reservado até o pagamento.';
  }
  return paymentStatusLabels[s.payment_status];
}

/** Continua consultando enquanto algo pode mudar sem ação do comprador. */
export function shouldPoll(s: CheckoutOrderStatus | null | undefined): boolean {
  if (!s) return false;
  return s.payment_status === 'pending' || s.refund_pending;
}

// ---------------------------------------------------------------------
// Erros da Edge Function
// ---------------------------------------------------------------------

const fieldLabels: Record<string, string> = {
  customer_name: 'nome',
  customer_email: 'e-mail',
  customer_phone: 'telefone',
  customer_document: 'CPF',
  ship_postal_code: 'CEP',
  ship_street: 'rua',
  ship_number: 'número',
  ship_complement: 'complemento',
  ship_district: 'bairro',
  ship_city: 'cidade',
  ship_state: 'estado',
  token: 'dados do cartão',
  installments: 'parcelas',
};

const checkoutMessages: Record<string, string> = {
  not_configured: 'Pagamentos ainda não configurados nesta loja. Tente mais tarde.',
  unavailable: 'Este produto não está mais disponível para compra.',
  out_of_stock: 'Estoque insuficiente para a quantidade escolhida.',
  rate_limited: 'Muitas tentativas agora. Aguarde alguns minutos e tente de novo.',
  invalid_buyer: 'Revise seus dados de contato e entrega.',
  payment_rejected:
    'Pagamento recusado pelo emissor. Confira os dados do cartão ou escolha outro meio.',
  payment_refused: 'O Mercado Pago recusou o pagamento. Confira os dados ou escolha outro meio.',
  provider_unavailable: 'O Mercado Pago não respondeu. Tente de novo em instantes.',
  not_found: 'Produto não encontrado.',
  forbidden: 'Sem permissão para esta ação.',
  not_refundable: 'Este pagamento não pode ser estornado agora.',
  already_shipped:
    'O fornecedor já enviou: estorne pelo painel do Mercado Pago e trate a devolução.',
  refund_refused: 'O Mercado Pago recusou o estorno. Veja o pagamento no painel dele.',
};

export class CheckoutError extends Error {
  constructor(
    readonly code: string,
    readonly field: string | null = null,
  ) {
    super(code);
  }
}

export function checkoutErrorMessage(error: unknown): string {
  if (error instanceof CheckoutError) {
    if (error.code === 'invalid_body' && error.field && fieldLabels[error.field]) {
      return `Confira o campo ${fieldLabels[error.field]}.`;
    }
    const known = checkoutMessages[error.code];
    if (known) return known;
  }
  return 'Não foi possível concluir agora. Tente de novo em instantes.';
}

// ---------------------------------------------------------------------
// Vendedor: situação do checkout do produto
// ---------------------------------------------------------------------

export const productCheckoutSchema = z.object({
  enabled: z.boolean(),
  block_reason: z
    .enum([
      'not_found',
      'seller_unavailable',
      'not_imported',
      'inactive',
      'listing_unavailable',
      'price_below_cost',
      'commission_not_configured',
    ])
    .nullable(),
  quote: z
    .object({
      unit_price_cents: z.number().int(),
      supplier_cents: z.number().int(),
      seller_commission_bps: z.number().int(),
      seller_commission_source: z.string(),
      seller_commission_cents: z.number().int(),
      platform_before_fee_cents: z.number().int(),
    })
    .nullable(),
});

export type ProductCheckout = z.infer<typeof productCheckoutSchema>;

export const blockReasonLabels: Record<NonNullable<ProductCheckout['block_reason']>, string> = {
  not_found: 'Produto não encontrado.',
  seller_unavailable: 'A loja está suspensa.',
  not_imported:
    'Só produtos importados do catálogo de fornecedores podem ser vendidos pelo checkout.',
  inactive: 'Ative o produto (e ao menos uma variação) para vender pelo checkout.',
  listing_unavailable: 'O anúncio do fornecedor não está disponível no catálogo.',
  price_below_cost: 'O preço não cobre o custo do fornecedor e a sua comissão. Aumente o preço.',
  commission_not_configured: 'Comissão não configurada pela equipe.',
};

/** Link público do checkout de um produto. */
export const checkoutLink = (origin: string, productId: string) => `${origin}/c/${productId}`;
