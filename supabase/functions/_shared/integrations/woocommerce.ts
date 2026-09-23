import {
  NormalizeError,
  cleanDocument,
  cleanEmail,
  cleanPhone,
  compact,
  decimalToCents,
  onlyDigits,
  splitStreet,
  str,
  type NormalizeResult,
} from './common.ts';

/** Cabeçalho com a assinatura HMAC-SHA256 (base64) do corpo. */
export const WOOCOMMERCE_SIGNATURE_HEADER = 'x-wc-webhook-signature';

/** Só estes status viram pedido; o resto (pendente de pagamento, falho, cancelado…) é ignorado. */
const IMPORTABLE_STATUSES = new Set(['processing', 'on-hold', 'completed']);

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});

/**
 * Webhook de pedido (`order.created`/`order.updated`) do WooCommerce → pedido normalizado.
 *
 * Assine também `order.updated`: pedido "aguardando pagamento" só é importado
 * quando passa a `processing` (a ingestão é idempotente pelo id do pedido).
 * Usa os campos do plugin Brazilian Market (`number`, `neighborhood`, `cpf`,
 * `cnpj`) quando existem; sem eles, o número vem do fim de `address_1`.
 * O preço unitário sai do subtotal da linha (texto), sem float.
 */
export function normalizeWooOrder(payload: unknown): NormalizeResult {
  const p = obj(payload);
  const id = p.id;
  if ((typeof id !== 'number' && typeof id !== 'string') || String(id) === '') {
    throw new NormalizeError('pedido sem id');
  }
  if (!Array.isArray(p.line_items) || p.line_items.length === 0) {
    throw new NormalizeError('pedido sem itens');
  }
  const status = str(p.status);
  if (!IMPORTABLE_STATUSES.has(status)) {
    return { kind: 'skip', reason: `status ${status || 'desconhecido'} não é importado` };
  }

  const billing = obj(p.billing);
  const shipping = obj(p.shipping);
  // Entrega vazia (só cobrança) usa o endereço de cobrança.
  const addr = str(shipping.address_1) ? shipping : billing;
  const name =
    `${str(addr.first_name)} ${str(addr.last_name)}`.trim() ||
    `${str(billing.first_name)} ${str(billing.last_name)}`.trim();

  const split = splitStreet(str(addr.address_1));
  const number = str(addr.number) || split.number;
  const street = str(addr.number) ? str(addr.address_1) : split.street;

  const items = p.line_items.map((raw) => {
    const li = obj(raw);
    const sku = str(li.sku);
    const external =
      sku ||
      (li.variation_id ? `variant:${String(li.variation_id)}` : '') ||
      (li.product_id ? `product:${String(li.product_id)}` : '');
    if (!external) throw new NormalizeError('item sem SKU nem produto');
    const quantity = Number(li.quantity);
    if (!Number.isInteger(quantity) || quantity < 1)
      throw new NormalizeError('quantidade inválida');
    // subtotal = total da linha antes de descontos; divide por unidade com arredondamento.
    const lineCents = decimalToCents(li.subtotal ?? li.total ?? '0');
    return {
      external_item_id: external,
      quantity,
      unit_price_cents: Math.round(lineCents / quantity),
    };
  });

  return {
    kind: 'order',
    externalId: String(id),
    order: compact({
      customer_name: name,
      customer_email: cleanEmail(billing.email),
      customer_phone: cleanPhone(billing.phone) ?? cleanPhone(shipping.phone),
      customer_document: cleanDocument(billing.cnpj) ?? cleanDocument(billing.cpf),
      ship_postal_code: onlyDigits(addr.postcode),
      ship_street: street,
      ship_number: number,
      ship_complement: str(addr.address_2) || undefined,
      ship_district: str(addr.neighborhood) || 'Não informado',
      ship_city: str(addr.city),
      ship_state: str(addr.state).toUpperCase(),
      shipping_cents: p.shipping_total == null ? 0 : decimalToCents(p.shipping_total),
      discount_cents: p.discount_total == null ? 0 : decimalToCents(p.discount_total),
      notes:
        `WooCommerce #${str(p.number) || String(id)}${str(p.customer_note) ? ` — ${str(p.customer_note)}` : ''}`.slice(
          0,
          1000,
        ),
      items,
    }),
  };
}
