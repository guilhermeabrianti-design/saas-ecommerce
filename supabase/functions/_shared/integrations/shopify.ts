import {
  NormalizeError,
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
export const SHOPIFY_SIGNATURE_HEADER = 'x-shopify-hmac-sha256';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});

/**
 * Webhook `orders/create` ou `orders/paid` da Shopify → pedido normalizado.
 *
 * Suposições (a Shopify não tem campos próprios para tudo o que o pedido
 * exige): o número vem do fim de `address1`, o complemento de `address2`, e
 * bairro/CPF não existem no payload padrão ("Não informado"/ausente). O item é
 * identificado pelo SKU (ou `variant:<id>` quando a variação não tem SKU).
 */
export function normalizeShopifyOrder(payload: unknown): NormalizeResult {
  const p = obj(payload);
  const id = p.id;
  if ((typeof id !== 'number' && typeof id !== 'string') || String(id) === '') {
    throw new NormalizeError('pedido sem id');
  }
  if (!Array.isArray(p.line_items) || p.line_items.length === 0) {
    throw new NormalizeError('pedido sem itens');
  }
  if (p.cancelled_at) return { kind: 'skip', reason: 'pedido cancelado' };
  if (p.financial_status === 'voided' || p.financial_status === 'refunded') {
    return { kind: 'skip', reason: `pagamento ${String(p.financial_status)}` };
  }

  const ship = obj(p.shipping_address);
  const customer = obj(p.customer);
  if (Object.keys(ship).length === 0) {
    return { kind: 'skip', reason: 'pedido sem endereço de entrega (produto digital?)' };
  }

  const name =
    str(ship.name) ||
    `${str(ship.first_name)} ${str(ship.last_name)}`.trim() ||
    `${str(customer.first_name)} ${str(customer.last_name)}`.trim();
  const { street, number } = splitStreet(str(ship.address1));

  const shipping = Array.isArray(p.shipping_lines)
    ? p.shipping_lines.reduce((sum: number, l) => sum + decimalToCents(obj(l).price ?? '0'), 0)
    : 0;

  const items = p.line_items.map((raw) => {
    const li = obj(raw);
    const sku = str(li.sku);
    const external = sku || (li.variant_id ? `variant:${String(li.variant_id)}` : '');
    if (!external) throw new NormalizeError('item sem SKU nem variação');
    return {
      external_item_id: external,
      quantity: Number(li.quantity),
      unit_price_cents: decimalToCents(li.price),
    };
  });

  return {
    kind: 'order',
    externalId: String(id),
    order: compact({
      customer_name: name,
      customer_email: cleanEmail(p.email) ?? cleanEmail(customer.email),
      customer_phone: cleanPhone(ship.phone) ?? cleanPhone(p.phone) ?? cleanPhone(customer.phone),
      ship_postal_code: onlyDigits(ship.zip),
      ship_street: street,
      ship_number: number,
      ship_complement: str(ship.address2) || undefined,
      ship_district: 'Não informado',
      ship_city: str(ship.city),
      ship_state: str(ship.province_code).toUpperCase(),
      shipping_cents: shipping,
      discount_cents: p.total_discounts == null ? 0 : decimalToCents(p.total_discounts),
      notes:
        `Shopify ${str(p.name) || `#${String(id)}`}${str(p.note) ? ` — ${str(p.note)}` : ''}`.slice(
          0,
          1000,
        ),
      items,
    }),
  };
}
