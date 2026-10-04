// @vitest-environment node
import { createHmac } from 'node:crypto';
import { StockPushError } from '../../supabase/functions/_shared/integrations/stock';
import {
  authorizationUrl,
  fetchTikTokLabel,
  normalizeTikTokOrder,
  parseTikTokTokens,
  parseTikTokWebhook,
  pickShop,
  pushTikTokStock,
  requestTikTokTokens,
  shipPackageDropOff,
  tiktokClient,
  tiktokPackages,
  tiktokSign,
  tiktokUrl,
  trustedDocumentUrl,
  unwrapTikTok,
  verifyTikTokWebhook,
  type TikTokClient,
} from '../../supabase/functions/_shared/integrations/tiktok';

const app = { appKey: 'chaveapp', appSecret: 'segredo', serviceId: '7000001' };
const hmac = (msg: string) => createHmac('sha256', 'segredo').update(msg).digest('hex');

const order = {
  id: '576461413038785752',
  status: 'AWAITING_SHIPMENT',
  fulfillment_type: 'FULFILLMENT_BY_SELLER',
  shipping_type: 'TIKTOK',
  buyer_email: 'maria@example.com',
  cpf: '123.456.789-09',
  payment: { currency: 'BRL', shipping_fee: '12.50', total_amount: '132.30' },
  recipient_address: {
    name: 'Maria Silva',
    phone_number: '(+55)11987654321',
    address_line1: 'Av. Paulista',
    address_line2: '1000',
    address_line3: 'Apto 12',
    postal_code: '01310-100',
    district_info: [
      { address_level: 'L0', address_level_name: 'Country', address_name: 'Brasil' },
      { address_level: 'L1', address_level_name: 'State', address_name: 'São Paulo' },
      { address_level: 'L2', address_level_name: 'City', address_name: 'São Paulo' },
      { address_level: 'L3', address_level_name: 'District', address_name: 'Bela Vista' },
    ],
  },
  line_items: [
    { id: '1', sku_id: '900', seller_sku: 'CAM-AZ-M', sale_price: '59.90' },
    { id: '2', sku_id: '900', seller_sku: 'CAM-AZ-M', sale_price: '59.90' },
    { id: '3', sku_id: '901', seller_sku: '', sale_price: '0.10', is_gift: true },
  ],
  packages: [{ id: '1152921504' }, { id: '1152921504' }],
};

function fakeClient(routes: Record<string, (arg?: unknown) => unknown>) {
  const calls: { path: string; arg?: unknown }[] = [];
  const handle = (path: string, arg?: unknown) => {
    calls.push({ path, arg });
    const fn = routes[path];
    if (!fn) throw new Error(`rota não esperada: ${path}`);
    return fn(arg) as Record<string, unknown>;
  };
  const client: TikTokClient = {
    get: async (path, query) => handle(path, query),
    post: async (path, body) => handle(path, body),
    put: async (path, body) => handle(path, body),
  };
  return { client, calls };
}

describe('assinatura e autorização da TikTok Shop', () => {
  it('assina segredo + caminho + parâmetros ordenados + corpo + segredo', async () => {
    const params = {
      timestamp: '1700000000',
      app_key: 'chaveapp',
      shop_cipher: 'ROW_x',
      sign: 'x',
      access_token: 'y',
    };
    expect(await tiktokSign('segredo', '/order/202309/orders', params)).toBe(
      hmac('segredo/order/202309/ordersapp_keychaveappshop_cipherROW_xtimestamp1700000000segredo'),
    );
    expect(await tiktokSign('segredo', '/p', { a: '1' }, '{"x":1}')).toBe(
      hmac('segredo/pa1{"x":1}segredo'),
    );
  });

  it('URL assinada leva app_key, timestamp, shop_cipher e sign', async () => {
    const url = new URL(
      await tiktokUrl(app, '/order/202309/orders', {
        shopCipher: 'ROW_x',
        query: { ids: '1' },
        timestamp: 1700000000,
      }),
    );
    expect(url.origin).toBe('https://open-api.tiktokglobalshop.com');
    expect(url.searchParams.get('shop_cipher')).toBe('ROW_x');
    expect(url.searchParams.get('sign')).toBe(
      hmac(
        'segredo/order/202309/ordersapp_keychaveappids1shop_cipherROW_xtimestamp1700000000segredo',
      ),
    );
  });

  it('link de autorização com service_id e state', () => {
    const url = new URL(authorizationUrl(app, 'abc'));
    expect(url.origin + url.pathname).toBe('https://services.tiktokshop.com/open/authorize');
    expect(url.searchParams.get('service_id')).toBe('7000001');
    expect(url.searchParams.get('state')).toBe('abc');
  });

  it('tokens: vencimento é data; erro e formato inválido', () => {
    expect(
      parseTikTokTokens(
        {
          code: 0,
          data: {
            access_token: 'a',
            refresh_token: 'r',
            access_token_expire_in: 1000 + 604800,
            open_id: 'o1',
          },
        },
        1000,
      ),
    ).toEqual({ access_token: 'a', refresh_token: 'r', expires_in: 604800, user_id: 'o1' });
    expect(() => parseTikTokTokens({ code: 36004004, message: 'código inválido' })).toThrow(
      /autorização recusada/,
    );
    expect(() =>
      parseTikTokTokens(
        { code: 0, data: { access_token: 'a', refresh_token: 'r', access_token_expire_in: 5 } },
        1000,
      ),
    ).toThrow(StockPushError);
  });

  it('troca do código e renovação no host de autenticação', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            code: 0,
            data: { access_token: 'a', refresh_token: 'r', access_token_expire_in: 9999999999 },
          }),
        ),
    );
    await requestTikTokTokens(fetchFn, app, { code: 'c0de' });
    const u1 = new URL(fetchFn.mock.calls[0]![0]);
    expect(u1.origin + u1.pathname).toBe('https://auth.tiktok-shops.com/api/v2/token/get');
    expect(u1.searchParams.get('auth_code')).toBe('c0de');
    expect(u1.searchParams.get('grant_type')).toBe('authorized_code');
    await requestTikTokTokens(fetchFn, app, { refreshToken: 'r' });
    const u2 = new URL(fetchFn.mock.calls[1]![0]);
    expect(u2.pathname).toBe('/api/v2/token/refresh');
    expect(u2.searchParams.get('grant_type')).toBe('refresh_token');
  });

  it('escolhe a loja do Brasil', () => {
    expect(
      pickShop({
        shops: [
          { id: '111', cipher: 'ROW_a', name: 'US', region: 'US' },
          { id: '222', cipher: 'ROW_b', name: 'Loja BR', region: 'BR' },
        ],
      }),
    ).toEqual({ id: '222', cipher: 'ROW_b', name: 'Loja BR', region: 'BR' });
    expect(pickShop({ shops: [{ id: '111', cipher: 'ROW_a', region: 'MX' }] })?.id).toBe('111');
    expect(pickShop({ shops: [{ id: 'x', cipher: 'ROW_a' }] })).toBeNull();
    expect(pickShop({})).toBeNull();
  });

  it('erros da API viram mensagens curtas', () => {
    expect(unwrapTikTok(200, { code: 0, data: { ok: 1 } })).toEqual({ ok: 1 });
    expect(() => unwrapTikTok(200, { code: 105002, message: 'expired' })).toThrow(/reconecte/);
    expect(() => unwrapTikTok(429, {})).toThrow(/limite/);
    expect(() => unwrapTikTok(200, { code: 12019001, message: 'sku inválido' })).toThrow(
      'TikTok Shop: erro 12019001 — sku inválido',
    );
    expect(() => unwrapTikTok(500, null)).toThrow(/HTTP 500/);
  });

  it('cliente envia o token no cabeçalho e assina o corpo', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ code: 0, data: {} })),
    );
    const api = tiktokClient(fetchFn, app, { accessToken: 'tok', shopCipher: 'ROW_x' });
    await api.post('/p', { a: 1 }, { page_size: '10' });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect((init!.headers as Record<string, string>)['x-tts-access-token']).toBe('tok');
    expect(init!.body).toBe('{"a":1}');
    const q = new URL(url).searchParams;
    expect(q.get('page_size')).toBe('10');
    expect(q.get('access_token')).toBeNull();
  });
});

describe('webhook da TikTok Shop', () => {
  const body = JSON.stringify({
    type: 1,
    shop_id: '7494061928453720000',
    timestamp: 1,
    data: { order_id: '576461413038785752', order_status: 'AWAITING_SHIPMENT' },
  });

  it('confere a assinatura app_key + corpo', async () => {
    expect(await verifyTikTokWebhook(app, body, hmac(`chaveapp${body}`))).toBe(true);
    expect(await verifyTikTokWebhook(app, body, hmac(body))).toBe(false);
    expect(await verifyTikTokWebhook(app, body, null)).toBe(false);
  });

  it('só mudança de status de pedido', () => {
    expect(parseTikTokWebhook(JSON.parse(body))).toEqual({
      shopId: '7494061928453720000',
      orderId: '576461413038785752',
    });
    expect(
      parseTikTokWebhook({ type: 5, shop_id: '1', data: { order_id: '576461413038785752' } }),
    ).toBeNull();
    expect(parseTikTokWebhook({ type: 1, shop_id: '1', data: { order_id: '../x' } })).toBeNull();
  });
});

describe('pedido da TikTok Shop', () => {
  it('normaliza: agrupa unidades, ignora brinde, endereço por níveis', () => {
    expect(normalizeTikTokOrder(order)).toEqual({
      kind: 'order',
      externalId: '576461413038785752',
      order: {
        customer_name: 'Maria Silva',
        customer_email: 'maria@example.com',
        customer_phone: '5511987654321',
        customer_document: '12345678909',
        ship_postal_code: '01310100',
        ship_street: 'Av. Paulista',
        ship_number: '1000',
        ship_complement: 'Apto 12',
        ship_district: 'Bela Vista',
        ship_city: 'São Paulo',
        ship_state: 'SP',
        shipping_cents: 1250,
        discount_cents: 0,
        notes: 'TikTok Shop #576461413038785752',
        items: [{ external_item_id: 'CAM-AZ-M', quantity: 2, unit_price_cents: 5990 }],
      },
    });
  });

  it('número junto da rua e SKU ausente', () => {
    const r = normalizeTikTokOrder({
      ...order,
      recipient_address: {
        ...order.recipient_address,
        address_line1: 'Rua das Flores, 45',
        address_line2: '',
        address_line3: '',
      },
      line_items: [{ id: '1', sku_id: '900', sale_price: '10' }],
    });
    expect(r.kind === 'order' && r.order).toMatchObject({
      ship_street: 'Rua das Flores',
      ship_number: '45',
      items: [{ external_item_id: 'sku:900', quantity: 1, unit_price_cents: 1000 }],
    });
    expect(r.kind === 'order' && r.order.ship_complement).toBeUndefined();
  });

  it('só aguardando envio e enviado pelo vendedor', () => {
    for (const status of ['UNPAID', 'ON_HOLD', 'CANCELLED', 'IN_TRANSIT', 'AWAITING_COLLECTION'])
      expect(normalizeTikTokOrder({ ...order, status }).kind).toBe('skip');
    expect(normalizeTikTokOrder({ ...order, fulfillment_type: 'FULFILLMENT_BY_TIKTOK' }).kind).toBe(
      'skip',
    );
  });

  it('dados inválidos não passam', () => {
    expect(() => normalizeTikTokOrder({ ...order, id: '' })).toThrow(/sem id/);
    expect(() => normalizeTikTokOrder({ ...order, line_items: [] })).toThrow(/sem itens/);
  });

  it('pacotes sem repetição', () => {
    expect(tiktokPackages(order)).toEqual(['1152921504']);
  });
});

describe('envio e etiqueta da TikTok Shop', () => {
  const pdf = new TextEncoder().encode('%PDF-1.7 etiqueta');
  const docUrl = 'https://open-fs-va.tiktokshop.com/wsos_v2/doc/1.pdf';

  it('organiza o pacote por postagem', async () => {
    const { client, calls } = fakeClient({
      '/fulfillment/202309/packages/115/ship': () => ({}),
    });
    await shipPackageDropOff(client, '115');
    expect(calls).toEqual([
      { path: '/fulfillment/202309/packages/115/ship', arg: { handover_method: 'DROP_OFF' } },
    ]);
  });

  it('só baixa de hosts da TikTok Shop', () => {
    expect(trustedDocumentUrl(docUrl)).toBe(true);
    expect(trustedDocumentUrl('https://evil.example/tiktokshop.com/x.pdf')).toBe(false);
    expect(trustedDocumentUrl('https://tiktokshop.com.evil.example/x.pdf')).toBe(false);
    expect(trustedDocumentUrl('http://open-fs-va.tiktokshop.com/x.pdf')).toBe(false);
  });

  it('baixa a etiqueta conferida', async () => {
    const { client } = fakeClient({
      '/fulfillment/202309/packages/115/shipping_documents': () => ({
        doc_url: docUrl,
        tracking_number: 'br999',
      }),
    });
    const fetchFn = vi.fn(async () => new Response(pdf));
    expect(await fetchTikTokLabel(client, fetchFn, '115')).toEqual({
      kind: 'ready',
      bytes: pdf,
      tracking: 'BR999',
      ref: '115',
    });
    expect(fetchFn).toHaveBeenCalledWith(docUrl, expect.objectContaining({ redirect: 'error' }));
  });

  it('sem envio organizado: pendente; host ou formato estranho: erro', async () => {
    const notReady = fakeClient({
      '/fulfillment/202309/packages/115/shipping_documents': () => {
        throw new StockPushError('TikTok Shop: erro 21011001 — package not shipped');
      },
    });
    expect(await fetchTikTokLabel(notReady.client, vi.fn(), '115')).toEqual({
      kind: 'pending',
      reason: 'envio ainda não organizado na TikTok Shop',
    });
    const evil = fakeClient({
      '/fulfillment/202309/packages/115/shipping_documents': () => ({
        doc_url: 'https://evil.example/x.pdf',
      }),
    });
    await expect(fetchTikTokLabel(evil.client, vi.fn(), '115')).rejects.toThrow(/inesperado/);
    const html = fakeClient({
      '/fulfillment/202309/packages/115/shipping_documents': () => ({ doc_url: docUrl }),
    });
    await expect(
      fetchTikTokLabel(html.client, async () => new Response('<html>'), '115'),
    ).rejects.toThrow(/formato inesperado/);
  });
});

describe('estoque na TikTok Shop', () => {
  it('procura pelo SKU do vendedor e atualiza no depósito', async () => {
    const { client, calls } = fakeClient({
      '/product/202309/products/search': () => ({
        products: [
          {
            id: '1729',
            skus: [
              {
                id: '900',
                seller_sku: 'CAM-AZ-M',
                inventory: [{ warehouse_id: '7068', quantity: 3 }],
              },
              {
                id: '901',
                seller_sku: 'CAM-AZ-G',
                inventory: [{ warehouse_id: '7068', quantity: 1 }],
              },
            ],
          },
        ],
      }),
      '/product/202309/products/1729/inventory/update': () => ({}),
    });
    expect(await pushTikTokStock(client, { sku: 'CAM-AZ-M', available: 5, ref: null })).toBe(
      '1729:900:7068',
    );
    expect(calls[0]!.arg).toEqual({ seller_skus: ['CAM-AZ-M'] });
    expect(calls[1]).toEqual({
      path: '/product/202309/products/1729/inventory/update',
      arg: { skus: [{ id: '900', inventory: [{ warehouse_id: '7068', quantity: 5 }] }] },
    });
  });

  it('usa a referência guardada; SKU ausente ou repetido é erro', async () => {
    const saved = fakeClient({ '/product/202309/products/1/inventory/update': () => ({}) });
    expect(await pushTikTokStock(saved.client, { sku: 'X', available: 0, ref: '1:2:3' })).toBe(
      '1:2:3',
    );
    expect(saved.calls).toHaveLength(1);

    const none = fakeClient({ '/product/202309/products/search': () => ({ products: [] }) });
    await expect(
      pushTikTokStock(none.client, { sku: 'X', available: 1, ref: null }),
    ).rejects.toThrow(/não encontrado/);

    const twice = fakeClient({
      '/product/202309/products/search': () => ({
        products: [
          { id: '1', skus: [{ id: '2', seller_sku: 'X', inventory: [{ warehouse_id: '9' }] }] },
          { id: '3', skus: [{ id: '4', seller_sku: 'X', inventory: [{ warehouse_id: '9' }] }] },
        ],
      }),
    });
    await expect(
      pushTikTokStock(twice.client, { sku: 'X', available: 1, ref: null }),
    ).rejects.toThrow(/mais de um/);
  });
});
