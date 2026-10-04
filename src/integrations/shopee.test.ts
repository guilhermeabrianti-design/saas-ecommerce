// @vitest-environment node
import { createHmac } from 'node:crypto';
import { toUf } from '../../supabase/functions/_shared/integrations/common';
import {
  arrangeDropoff,
  authorizationUrl,
  fetchShopeeLabel,
  normalizeShopeeOrder,
  parseShopeePush,
  parseShopeeTokens,
  pushShopeeStock,
  requestShopeeTokens,
  shopeeClient,
  shopeeItemRefs,
  shopeeSign,
  shopeeUrl,
  unwrapShopee,
  verifyShopeePush,
  type ShopeeClient,
} from '../../supabase/functions/_shared/integrations/shopee';
import { StockPushError } from '../../supabase/functions/_shared/integrations/stock';

const app = { host: 'https://partner.shopeemobile.com', partnerId: '2001234', partnerKey: 'chave' };
const hmac = (msg: string) => createHmac('sha256', 'chave').update(msg).digest('hex');

const order = {
  order_sn: '240101ABCDEF12',
  order_status: 'READY_TO_SHIP',
  buyer_username: 'maria_compra',
  fulfillment_flag: 'fulfilled_by_local_seller',
  recipient_address: {
    name: 'Maria Silva',
    phone: '5511987654321',
    town: 'Bela Vista',
    district: 'Bela Vista',
    city: 'São Paulo',
    state: 'São Paulo',
    zipcode: '01310-100',
    full_address: 'Av. Paulista, 1000, Apto 12, Bela Vista, São Paulo, SP, 01310100',
  },
  item_list: [
    {
      item_id: 111,
      item_sku: 'CAM',
      model_id: 222,
      model_sku: 'CAM-AZ-M',
      model_quantity_purchased: 2,
      model_discounted_price: 59.9,
      model_original_price: 69.9,
    },
    {
      item_id: 333,
      item_sku: 'BONE',
      model_id: 0,
      model_sku: '',
      model_quantity_purchased: 1,
      model_discounted_price: 30,
    },
  ],
};

/** Cliente falso: respostas por caminho, registrando as chamadas. */
function fakeClient(routes: Record<string, (body?: unknown) => unknown>) {
  const calls: { path: string; arg?: unknown }[] = [];
  const handle = (path: string, arg?: unknown) => {
    calls.push({ path, arg });
    const fn = routes[path];
    if (!fn) throw new Error(`rota não esperada: ${path}`);
    return fn(arg);
  };
  const client: ShopeeClient = {
    get: async (path, query) => handle(path, query) as Record<string, unknown>,
    post: async (path, body) => handle(path, body) as Record<string, unknown>,
    download: async (path, body) => handle(path, body) as Uint8Array,
  };
  return { client, calls };
}

describe('assinatura e autorização da Shopee', () => {
  it('assina com partner_id + caminho + timestamp (e token + loja nas chamadas da loja)', async () => {
    expect(await shopeeSign(app, '/api/v2/shop/auth_partner', 1700000000)).toBe(
      hmac('2001234/api/v2/shop/auth_partner1700000000'),
    );
    expect(
      await shopeeSign(app, '/api/v2/order/get_order_detail', 1700000000, {
        accessToken: 'tok',
        shopId: '55',
      }),
    ).toBe(hmac('2001234/api/v2/order/get_order_detail1700000000tok55'));
  });

  it('URL de autorização com redirect e assinatura', async () => {
    const url = new URL(
      await authorizationUrl(
        app,
        'https://x.supabase.co/functions/v1/shopee/callback?state=abc',
        1700000000,
      ),
    );
    expect(url.origin + url.pathname).toBe(
      'https://partner.shopeemobile.com/api/v2/shop/auth_partner',
    );
    expect(url.searchParams.get('partner_id')).toBe('2001234');
    expect(url.searchParams.get('redirect')).toBe(
      'https://x.supabase.co/functions/v1/shopee/callback?state=abc',
    );
    expect(url.searchParams.get('sign')).toBe(hmac('2001234/api/v2/shop/auth_partner1700000000'));
  });

  it('URL da loja leva access_token e shop_id', async () => {
    const url = new URL(
      await shopeeUrl(app, '/api/v2/product/search_item', {
        timestamp: 1,
        shop: { accessToken: 'tok', shopId: '55' },
        query: { item_sku: 'A B' },
      }),
    );
    expect(url.searchParams.get('access_token')).toBe('tok');
    expect(url.searchParams.get('shop_id')).toBe('55');
    expect(url.searchParams.get('item_sku')).toBe('A B');
  });

  it('tokens: resposta válida, erro e formato inválido', () => {
    expect(
      parseShopeeTokens({ access_token: 'a', refresh_token: 'r', expire_in: 14400 }, '55'),
    ).toEqual({ access_token: 'a', refresh_token: 'r', expires_in: 14400, user_id: '55' });
    expect(() =>
      parseShopeeTokens({ error: 'error_auth', message: 'code expirado' }, '55'),
    ).toThrow(/autorização recusada/);
    expect(() => parseShopeeTokens({ access_token: 'a' }, '55')).toThrow(StockPushError);
    expect(() =>
      parseShopeeTokens({ access_token: 'a', refresh_token: 'r', expire_in: 1 }, 'x'),
    ).toThrow(StockPushError);
  });

  it('troca o código e renova pelo endpoint certo', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expire_in: 14400 })),
    );
    await requestShopeeTokens(fetchFn, app, { code: 'c0de', shopId: '55' });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(new URL(url).pathname).toBe('/api/v2/auth/token/get');
    expect(JSON.parse(String(init!.body))).toEqual({
      code: 'c0de',
      shop_id: 55,
      partner_id: 2001234,
    });
    await requestShopeeTokens(fetchFn, app, { refreshToken: 'r', shopId: '55' });
    const [url2, init2] = fetchFn.mock.calls[1]!;
    expect(new URL(url2).pathname).toBe('/api/v2/auth/access_token/get');
    expect(JSON.parse(String(init2!.body))).toMatchObject({ refresh_token: 'r', shop_id: 55 });
  });

  it('erros da API viram mensagens curtas', () => {
    expect(() => unwrapShopee(200, { error: 'error_auth', message: 'x' })).toThrow(/reconecte/);
    expect(() => unwrapShopee(200, { error: 'invalid_access_token' })).toThrow(/reconecte/);
    expect(() => unwrapShopee(429, {})).toThrow(/limite/);
    expect(() => unwrapShopee(200, { error: 'error_param', message: 'falta order_sn' })).toThrow(
      'Shopee: error_param — falta order_sn',
    );
    expect(unwrapShopee(200, { error: '', response: { ok: 1 } })).toEqual({ ok: 1 });
  });

  it('cliente: download recusa JSON no lugar do arquivo', async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ error: 'logistics.not_ready', message: 'x' }), {
        headers: { 'content-type': 'application/json' },
      });
    const api = shopeeClient(fetchFn, app, { accessToken: 't', shopId: '55' });
    await expect(api.download('/x', {})).rejects.toThrow(/logistics.not_ready/);
  });
});

describe('notificações da Shopee', () => {
  const pushUrl = 'https://x.supabase.co/functions/v1/shopee/push';
  const body = JSON.stringify({
    shop_id: 55,
    code: 3,
    timestamp: 1,
    data: { ordersn: '240101ABCDEF12', status: 'READY_TO_SHIP' },
  });

  it('confere a assinatura url|corpo', async () => {
    expect(await verifyShopeePush('chave', pushUrl, body, hmac(`${pushUrl}|${body}`))).toBe(true);
    expect(await verifyShopeePush('chave', pushUrl, body, hmac(`${pushUrl}|{}`))).toBe(false);
    expect(await verifyShopeePush('chave', pushUrl, body, null)).toBe(false);
  });

  it('só pedidos (code 3 e 4) com loja e pedido válidos', () => {
    expect(parseShopeePush(JSON.parse(body))).toEqual({ shopId: '55', orderSn: '240101ABCDEF12' });
    expect(parseShopeePush({ shop_id: 55, code: 4, data: { ordersn: '240101ABCDEF12' } })).toEqual({
      shopId: '55',
      orderSn: '240101ABCDEF12',
    });
    expect(parseShopeePush({ shop_id: 55, code: 1, data: {} })).toBeNull();
    expect(parseShopeePush({ shop_id: 55, code: 3, data: { ordersn: '../x' } })).toBeNull();
    expect(parseShopeePush({ code: 3, data: { ordersn: '240101ABCDEF12' } })).toBeNull();
  });
});

describe('pedido da Shopee', () => {
  it('normaliza pedido pago com endereço do Brasil', () => {
    const r = normalizeShopeeOrder(order);
    expect(r).toEqual({
      kind: 'order',
      externalId: '240101ABCDEF12',
      order: {
        customer_name: 'Maria Silva',
        customer_phone: '5511987654321',
        ship_postal_code: '01310100',
        ship_street: 'Av. Paulista',
        ship_number: '1000',
        ship_complement: 'Apto 12',
        ship_district: 'Bela Vista',
        ship_city: 'São Paulo',
        ship_state: 'SP',
        shipping_cents: 0,
        discount_cents: 0,
        notes: 'Shopee #240101ABCDEF12',
        items: [
          { external_item_id: 'CAM-AZ-M', quantity: 2, unit_price_cents: 5990 },
          { external_item_id: 'BONE', quantity: 1, unit_price_cents: 3000 },
        ],
      },
    });
  });

  it('endereço sem número separado e telefone mascarado', () => {
    const r = normalizeShopeeOrder({
      ...order,
      recipient_address: {
        ...order.recipient_address,
        phone: '******4321',
        full_address: 'Rua das Flores 45, Centro, Curitiba, Paraná, 80000000',
        state: 'Paraná',
        town: '',
        district: 'Centro',
      },
    });
    expect(r.kind === 'order' && r.order).toMatchObject({
      ship_street: 'Rua das Flores',
      ship_number: '45',
      ship_state: 'PR',
      ship_district: 'Centro',
    });
    expect(r.kind === 'order' && r.order.customer_phone).toBeUndefined();
    expect(r.kind === 'order' && r.order.ship_complement).toBeUndefined();
  });

  it('ignora não pagos, cancelados, já enviados e Full', () => {
    expect(normalizeShopeeOrder({ ...order, order_status: 'UNPAID' }).kind).toBe('skip');
    expect(normalizeShopeeOrder({ ...order, order_status: 'CANCELLED' }).kind).toBe('skip');
    expect(normalizeShopeeOrder({ ...order, order_status: 'SHIPPED' })).toEqual({
      kind: 'skip',
      reason: 'já em andamento na Shopee (SHIPPED)',
    });
    expect(normalizeShopeeOrder({ ...order, fulfillment_flag: 'fulfilled_by_shopee' }).kind).toBe(
      'skip',
    );
    expect(normalizeShopeeOrder({ ...order, order_status: 'INVOICE_PENDING' }).kind).toBe('order');
  });

  it('dados inválidos não passam', () => {
    expect(() => normalizeShopeeOrder({ ...order, order_sn: '' })).toThrow(/order_sn/);
    expect(() => normalizeShopeeOrder({ ...order, item_list: [] })).toThrow(/sem itens/);
    expect(() =>
      normalizeShopeeOrder({
        ...order,
        item_list: [{ ...order.item_list[0], model_quantity_purchased: 0 }],
      }),
    ).toThrow(/quantidade/);
  });

  it('item sem SKU usa o id da Shopee', () => {
    const r = normalizeShopeeOrder({
      ...order,
      item_list: [
        { item_id: 9, model_id: 8, model_quantity_purchased: 1, model_discounted_price: '10.00' },
        { item_id: 7, model_id: 0, model_quantity_purchased: 1, model_discounted_price: '5' },
      ],
    });
    expect(r.kind === 'order' && r.order.items.map((i) => i.external_item_id)).toEqual([
      'model:8',
      'item:7',
    ]);
  });

  it('referências item:variação por SKU', () => {
    expect(shopeeItemRefs(order)).toEqual([
      { sku: 'CAM-AZ-M', ref: '111:222' },
      { sku: 'BONE', ref: '333:0' },
    ]);
  });

  it('UF por nome ou sigla', () => {
    expect(toUf('São Paulo')).toBe('SP');
    expect(toUf('distrito federal')).toBe('DF');
    expect(toUf('BR-RJ')).toBe('RJ');
    expect(toUf('Atlantida')).toBe('');
  });
});

describe('envio e etiqueta da Shopee', () => {
  const pdf = new TextEncoder().encode('%PDF-1.4 etiqueta');

  it('organiza por postagem só quando nada mais é pedido', async () => {
    const ok = fakeClient({
      '/api/v2/logistics/get_shipping_parameter': () => ({ info_needed: { dropoff: [] } }),
      '/api/v2/logistics/ship_order': () => ({}),
    });
    expect(await arrangeDropoff(ok.client, 'SN123456')).toBe(true);
    expect(ok.calls[1]).toEqual({
      path: '/api/v2/logistics/ship_order',
      arg: { order_sn: 'SN123456', dropoff: {} },
    });

    const pickup = fakeClient({
      '/api/v2/logistics/get_shipping_parameter': () => ({
        info_needed: { pickup: ['address_id', 'pickup_time_id'] },
      }),
    });
    expect(await arrangeDropoff(pickup.client, 'SN123456')).toBe(false);

    const branch = fakeClient({
      '/api/v2/logistics/get_shipping_parameter': () => ({
        info_needed: { dropoff: ['branch_id'] },
      }),
    });
    expect(await arrangeDropoff(branch.client, 'SN123456')).toBe(false);
  });

  it('sem rastreio: espera o envio ser organizado', async () => {
    const { client } = fakeClient({
      '/api/v2/logistics/get_tracking_number': () => ({ tracking_number: '' }),
    });
    expect(await fetchShopeeLabel(client, 'SN123456')).toEqual({
      kind: 'pending',
      reason: 'envio ainda não organizado na Shopee',
    });
  });

  it('gera, espera e baixa a etiqueta', async () => {
    let polls = 0;
    const { client, calls } = fakeClient({
      '/api/v2/logistics/get_tracking_number': () => ({ tracking_number: 'br123456789' }),
      '/api/v2/logistics/get_shipping_document_parameter': () => ({
        result_list: [{ suggest_shipping_document_type: 'THERMAL_AIR_WAYBILL' }],
      }),
      '/api/v2/logistics/create_shipping_document': () => ({}),
      '/api/v2/logistics/get_shipping_document_result': () => ({
        result_list: [{ status: ++polls < 2 ? 'PROCESSING' : 'READY' }],
      }),
      '/api/v2/logistics/download_shipping_document': () => pdf,
    });
    const r = await fetchShopeeLabel(client, 'SN123456', { sleep: async () => {} });
    expect(r).toEqual({ kind: 'ready', bytes: pdf, tracking: 'BR123456789', ref: 'SN123456' });
    expect(calls.find((c) => c.path.endsWith('create_shipping_document'))!.arg).toEqual({
      order_list: [
        {
          order_sn: 'SN123456',
          tracking_number: 'BR123456789',
          shipping_document_type: 'THERMAL_AIR_WAYBILL',
        },
      ],
    });
  });

  it('ainda processando vira pendente; falha e formato errado viram erro', async () => {
    const routes = (status: string, file: Uint8Array = pdf) => ({
      '/api/v2/logistics/get_tracking_number': () => ({ tracking_number: 'BR1234' }),
      '/api/v2/logistics/get_shipping_document_parameter': () => ({ result_list: [{}] }),
      '/api/v2/logistics/create_shipping_document': () => ({}),
      '/api/v2/logistics/get_shipping_document_result': () => ({ result_list: [{ status }] }),
      '/api/v2/logistics/download_shipping_document': () => file,
    });
    const sleep = async () => {};
    expect(
      await fetchShopeeLabel(fakeClient(routes('PROCESSING')).client, 'SN123456', {
        sleep,
        attempts: 2,
      }),
    ).toEqual({ kind: 'pending', reason: 'etiqueta ainda sendo gerada' });
    await expect(
      fetchShopeeLabel(fakeClient(routes('FAILED')).client, 'SN123456', { sleep }),
    ).rejects.toThrow(/falha ao gerar/);
    await expect(
      fetchShopeeLabel(
        fakeClient(routes('READY', new TextEncoder().encode('<html>'))).client,
        'SN123456',
        { sleep },
      ),
    ).rejects.toThrow(/formato inesperado/);
  });
});

describe('estoque na Shopee', () => {
  it('usa a referência guardada', async () => {
    const { client, calls } = fakeClient({
      '/api/v2/product/update_stock': () => ({ success_list: [{ model_id: 222 }] }),
    });
    expect(await pushShopeeStock(client, { sku: 'CAM-AZ-M', available: 7, ref: '111:222' })).toBe(
      '111:222',
    );
    expect(calls).toEqual([
      {
        path: '/api/v2/product/update_stock',
        arg: { item_id: 111, stock_list: [{ model_id: 222, seller_stock: [{ stock: 7 }] }] },
      },
    ]);
  });

  it('sem referência, procura pelo SKU (anúncio ou variação)', async () => {
    const { client } = fakeClient({
      '/api/v2/product/search_item': () => ({ item_id_list: [111, 333] }),
      '/api/v2/product/get_item_base_info': () => ({
        item_list: [
          { item_id: 111, item_sku: 'CAM', has_model: true },
          { item_id: 333, item_sku: 'OUTRO', has_model: false },
        ],
      }),
      '/api/v2/product/get_model_list': () => ({
        model: [
          { model_id: 221, model_sku: 'CAM-AZ-P' },
          { model_id: 222, model_sku: 'CAM-AZ-M' },
        ],
      }),
      '/api/v2/product/update_stock': () => ({}),
    });
    expect(await pushShopeeStock(client, { sku: 'CAM-AZ-M', available: 3, ref: null })).toBe(
      '111:222',
    );

    const simple = fakeClient({
      '/api/v2/product/search_item': () => ({ item_id_list: [333] }),
      '/api/v2/product/get_item_base_info': () => ({
        item_list: [{ item_id: 333, item_sku: 'BONE', has_model: false }],
      }),
      '/api/v2/product/update_stock': () => ({}),
    });
    expect(await pushShopeeStock(simple.client, { sku: 'BONE', available: 0, ref: null })).toBe(
      '333:0',
    );
  });

  it('SKU ausente, repetido ou recusado: erro legível', async () => {
    const none = fakeClient({ '/api/v2/product/search_item': () => ({ item_id_list: [] }) });
    await expect(
      pushShopeeStock(none.client, { sku: 'X', available: 1, ref: null }),
    ).rejects.toThrow(/não encontrado na Shopee/);

    const twice = fakeClient({
      '/api/v2/product/search_item': () => ({ item_id_list: [1, 2] }),
      '/api/v2/product/get_item_base_info': () => ({
        item_list: [
          { item_id: 1, item_sku: 'X', has_model: false },
          { item_id: 2, item_sku: 'X', has_model: false },
        ],
      }),
    });
    await expect(
      pushShopeeStock(twice.client, { sku: 'X', available: 1, ref: null }),
    ).rejects.toThrow(/mais de um/);

    const refused = fakeClient({
      '/api/v2/product/update_stock': () => ({
        failure_list: [{ model_id: 0, failed_reason: 'item bloqueado' }],
      }),
    });
    await expect(
      pushShopeeStock(refused.client, { sku: 'X', available: 1, ref: '5:0' }),
    ).rejects.toThrow('Shopee: estoque recusado para X — item bloqueado');
  });
});
