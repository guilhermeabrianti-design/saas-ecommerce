// @vitest-environment node
import {
  authorizationUrl,
  codeChallenge,
  generateCodeVerifier,
  getAccessToken,
  needsRefresh,
  normalizeMercadoLivreOrder,
  parseNotification,
  parseTokenResponse,
  pushMercadoLivreStock,
  type StoredMlCredentials,
} from '../../supabase/functions/_shared/integrations/mercadolivre';
import { StockPushError } from '../../supabase/functions/_shared/integrations/stock';

const order = {
  id: 2000001,
  status: 'paid',
  pack_id: null,
  buyer: {
    first_name: 'Maria',
    last_name: 'Silva',
    nickname: 'MARIA123',
    billing_info: { doc_number: '12345678909' },
  },
  shipping: { id: 44 },
  order_items: [
    {
      item: { id: 'MLB1', variation_id: 9, seller_sku: 'FX-CAM-AZ' },
      quantity: 2,
      unit_price: 59.9,
    },
  ],
};

const shipment = {
  logistic_type: 'drop_off',
  lead_time: { cost: 19.5 },
  destination: {
    receiver_name: 'Maria Silva',
    receiver_phone: '(11) 98765-4321',
    shipping_address: {
      street_name: 'Av. Paulista',
      street_number: '1000',
      comment: 'Apto 12',
      zip_code: '01310-100',
      city: { name: 'São Paulo' },
      state: { id: 'BR-SP' },
      neighborhood: { name: 'Bela Vista' },
    },
  },
};

describe('OAuth com PKCE', () => {
  it('verifier, challenge S256 e URL de autorização', async () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    // Vetor do RFC 7636 (apêndice B).
    expect(await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    const url = new URL(
      authorizationUrl({
        clientId: '123',
        redirectUri: 'https://x.supabase.co/cb',
        state: 's',
        challenge: 'c',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://auth.mercadolivre.com.br/authorization');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: '123',
      redirect_uri: 'https://x.supabase.co/cb',
      state: 's',
      code_challenge: 'c',
      code_challenge_method: 'S256',
    });
  });

  it('resposta de token e prazo', () => {
    expect(
      parseTokenResponse({
        access_token: 'APP_USR-1',
        refresh_token: 'TG-1',
        expires_in: 21600,
        user_id: 777,
      }),
    ).toEqual({
      access_token: 'APP_USR-1',
      refresh_token: 'TG-1',
      expires_in: 21600,
      user_id: '777',
    });
    expect(() => parseTokenResponse({ access_token: 'x' })).toThrow(StockPushError);
    const now = new Date('2026-09-28T12:00:00Z');
    expect(needsRefresh('2026-09-28T12:04:00Z', now)).toBe(true);
    expect(needsRefresh('2026-09-28T13:00:00Z', now)).toBe(false);
    expect(needsRefresh(undefined, now)).toBe(true);
  });
});

describe('renovação do token', () => {
  const now = () => new Date('2026-09-28T12:00:00Z');
  const creds = (version: number, access: string, expires: string): StoredMlCredentials => ({
    secret: { access_token: access, refresh_token: `R${version}` },
    config: { token_version: version, expires_at: expires },
  });

  it('usa o atual enquanto vale; renova e grava com a versão esperada', async () => {
    const valid = await getAccessToken({
      read: async () => creds(1, 'A1', '2026-09-28T18:00:00Z'),
      swap: async () => true,
      refresh: async () => {
        throw new Error('não deveria renovar');
      },
      now,
    });
    expect(valid).toBe('A1');

    const swaps: [number, StoredMlCredentials][] = [];
    const renewed = await getAccessToken({
      read: async () => creds(1, 'A1', '2026-09-28T12:01:00Z'),
      swap: async (v, next) => {
        swaps.push([v, next]);
        return true;
      },
      refresh: async (r) => ({
        access_token: `novo-${r}`,
        refresh_token: 'R2',
        expires_in: 21600,
        user_id: '7',
      }),
      now,
    });
    expect(renewed).toBe('novo-R1');
    expect(swaps[0]![0]).toBe(1);
    expect(swaps[0]![1].config).toMatchObject({
      token_version: 2,
      expires_at: '2026-09-28T18:00:00.000Z',
    });
  });

  it('perdeu a corrida: usa o token que o outro processo gravou', async () => {
    let reads = 0;
    const token = await getAccessToken({
      read: async () =>
        ++reads === 1
          ? creds(1, 'A1', '2026-09-28T12:01:00Z')
          : creds(2, 'A2', '2026-09-28T18:00:00Z'),
      swap: async () => false,
      refresh: async () => ({
        access_token: 'meu',
        refresh_token: 'R',
        expires_in: 100,
        user_id: '7',
      }),
      now,
    });
    expect(token).toBe('A2');

    // Token de renovação já usado por outro: relê e segue com o novo.
    reads = 0;
    const second = await getAccessToken({
      read: async () =>
        ++reads === 1
          ? creds(1, 'A1', '2026-09-28T12:01:00Z')
          : creds(2, 'A2', '2026-09-28T18:00:00Z'),
      swap: async () => true,
      refresh: async () => {
        throw new StockPushError('invalid_grant');
      },
      now,
    });
    expect(second).toBe('A2');
  });
});

describe('notificações e pedidos', () => {
  it('aceita só orders_v2 do nosso app', () => {
    expect(
      parseNotification(
        { topic: 'orders_v2', resource: '/orders/2000001', user_id: 777, application_id: 123 },
        '123',
      ),
    ).toEqual({ topic: 'orders_v2', resourceId: '2000001', userId: '777' });
    expect(
      parseNotification(
        { topic: 'orders_v2', resource: '/orders/1', user_id: 7, application_id: 999 },
        '123',
      ),
    ).toBeNull();
    expect(
      parseNotification(
        { topic: 'items', resource: '/items/MLB1', user_id: 7, application_id: 123 },
        '123',
      ),
    ).toBeNull();
    expect(
      parseNotification(
        { topic: 'orders_v2', resource: '/orders/../x', user_id: 7, application_id: 123 },
        '123',
      ),
    ).toBeNull();
  });

  it('pedido pago com envio próprio vira pedido normalizado', () => {
    const r = normalizeMercadoLivreOrder(order, shipment);
    expect(r).toEqual({
      kind: 'order',
      externalId: '2000001',
      order: {
        customer_name: 'Maria Silva',
        customer_phone: '11987654321',
        customer_document: '12345678909',
        ship_postal_code: '01310100',
        ship_street: 'Av. Paulista',
        ship_number: '1000',
        ship_complement: 'Apto 12',
        ship_district: 'Bela Vista',
        ship_city: 'São Paulo',
        ship_state: 'SP',
        shipping_cents: 1950,
        discount_cents: 0,
        notes: 'Mercado Livre #2000001',
        items: [{ external_item_id: 'FX-CAM-AZ', quantity: 2, unit_price_cents: 5990 }],
      },
    });
  });

  it('ignora Full, sem envio, não pago e cancelado; item sem SKU usa a variação', () => {
    expect(
      normalizeMercadoLivreOrder(order, { ...shipment, logistic_type: 'fulfillment' }),
    ).toMatchObject({
      kind: 'skip',
      reason: expect.stringMatching(/Full/),
    });
    expect(normalizeMercadoLivreOrder(order, null)).toMatchObject({ kind: 'skip' });
    expect(
      normalizeMercadoLivreOrder({ ...order, status: 'payment_required' }, shipment),
    ).toMatchObject({
      kind: 'skip',
      reason: expect.stringMatching(/aguardando pagamento/),
    });
    expect(normalizeMercadoLivreOrder({ ...order, status: 'cancelled' }, shipment)).toMatchObject({
      kind: 'skip',
    });
    const noSku = normalizeMercadoLivreOrder(
      {
        ...order,
        order_items: [{ item: { id: 'MLB1', variation_id: 9 }, quantity: 1, unit_price: 10 }],
      },
      shipment,
    );
    expect(noSku.kind === 'order' && noSku.order.items[0]!.external_item_id).toBe('variation:9');
  });
});

describe('estoque', () => {
  function fakeFetch(responses: unknown[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify(responses.shift() ?? {}), { status: 200 });
    };
    return { fn, calls };
  }

  it('anúncio com variação: atualiza só a variação do SKU', async () => {
    const f = fakeFetch([
      { results: ['MLB1'] },
      {
        id: 'MLB1',
        variations: [
          { id: 1, attributes: [{ id: 'SELLER_SKU', value_name: 'FX-VM' }] },
          { id: 2, attributes: [{ id: 'SELLER_SKU', value_name: 'FX-AZ' }] },
        ],
      },
      {},
    ]);
    await pushMercadoLivreStock(f.fn, {
      accessToken: 'T',
      userId: '777',
      sku: 'FX-AZ',
      available: 5,
    });
    expect(f.calls[0]!.url).toBe(
      'https://api.mercadolibre.com/users/777/items/search?seller_sku=FX-AZ',
    );
    expect(f.calls[2]!.init.method).toBe('PUT');
    expect(JSON.parse(String(f.calls[2]!.init.body))).toEqual({
      variations: [{ id: 2, available_quantity: 5 }],
    });
    expect(f.calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer T' });
  });

  it('anúncio simples; SKU ausente ou duplicado vira erro legível', async () => {
    const simple = fakeFetch([{ results: ['MLB9'] }, { id: 'MLB9', variations: [] }, {}]);
    await pushMercadoLivreStock(simple.fn, {
      accessToken: 'T',
      userId: '7',
      sku: 'CANECA',
      available: 0,
    });
    expect(JSON.parse(String(simple.calls[2]!.init.body))).toEqual({ available_quantity: 0 });

    await expect(
      pushMercadoLivreStock(fakeFetch([{ results: [] }]).fn, {
        accessToken: 'T',
        userId: '7',
        sku: 'X',
        available: 1,
      }),
    ).rejects.toThrow('SKU X não encontrado no Mercado Livre');
    await expect(
      pushMercadoLivreStock(fakeFetch([{ results: ['A', 'B'] }]).fn, {
        accessToken: 'T',
        userId: '7',
        sku: 'X',
        available: 1,
      }),
    ).rejects.toThrow(/mais de um anúncio/);
  });
});
