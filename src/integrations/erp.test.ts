// @vitest-environment node
import {
  BLING_BATCH,
  blingAuthorizationUrl,
  blingStock,
  blingToken,
  parseBlingProducts,
  parseBlingToken,
  tinyCheckToken,
  tinyCursor,
  tinyStockUpdates,
  toQuantity,
} from '../../supabase/functions/_shared/integrations/erp';
import { StockPushError, type FetchFn } from '../../supabase/functions/_shared/integrations/stock';

function fakeFetch(responses: { status?: number; body: unknown }[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { fn, calls };
}

describe('saldo', () => {
  it('vira inteiro não negativo', () => {
    expect(toQuantity(149)).toBe(149);
    expect(toQuantity('10,9')).toBe(10);
    expect(toQuantity(-3)).toBe(0);
    expect(toQuantity('abc')).toBeNull();
    expect(toQuantity(undefined)).toBeNull();
    expect(toQuantity('')).toBeNull();
  });
});

describe('Bling', () => {
  it('URL de autorização e troca do token com Basic e JWT', async () => {
    expect(blingAuthorizationUrl('app123', 'st-1')).toBe(
      'https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=app123&state=st-1',
    );
    const { fn, calls } = fakeFetch([
      {
        body: { access_token: 'a1', refresh_token: 'r1', expires_in: 21600, token_type: 'Bearer' },
      },
    ]);
    expect(
      await blingToken(fn, {
        clientId: 'id',
        clientSecret: 'sec',
        body: { grant_type: 'authorization_code', code: 'c1' },
      }),
    ).toEqual({ access_token: 'a1', refresh_token: 'r1', expires_in: 21600 });
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(calls[0]!.url).toBe('https://api.bling.com.br/Api/v3/oauth/token');
    expect(headers.authorization).toBe(`Basic ${btoa('id:sec')}`);
    expect(headers['enable-jwt']).toBe('1');
    expect(calls[0]!.init!.body).toBe('grant_type=authorization_code&code=c1');
    expect(() => parseBlingToken({ access_token: 'x' })).toThrow(StockPushError);
  });

  it('lê o saldo pelos SKUs em lotes de 100', async () => {
    expect(
      parseBlingProducts({
        data: [
          { id: 1, codigo: 'CANECA', estoque: { saldoVirtualTotal: 149 } },
          { id: 2, codigo: '', estoque: { saldoVirtualTotal: 1 } },
          { id: 3, codigo: 'SEM-SALDO' },
        ],
      }),
    ).toEqual([{ sku: 'CANECA', quantity: 149 }]);

    const skus = Array.from({ length: BLING_BATCH + 1 }, (_, i) => `SKU${i}`);
    const { fn, calls } = fakeFetch([
      { body: { data: [{ codigo: 'SKU0', estoque: { saldoVirtualTotal: 5 } }] } },
      { body: { data: [{ codigo: 'SKU100', estoque: { saldoVirtualTotal: 0 } }] } },
    ]);
    expect(await blingStock(fn, 'tok', skus)).toEqual([
      { sku: 'SKU0', quantity: 5 },
      { sku: 'SKU100', quantity: 0 },
    ]);
    expect(calls).toHaveLength(2);
    const first = new URL(calls[0]!.url);
    expect(first.pathname).toBe('/Api/v3/produtos');
    expect(first.searchParams.getAll('codigos[]')).toHaveLength(BLING_BATCH);
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('erros legíveis', async () => {
    await expect(blingStock(fakeFetch([{ status: 401, body: {} }]).fn, 't', ['A'])).rejects.toThrow(
      /reconecte/,
    );
    await expect(blingStock(fakeFetch([{ status: 429, body: {} }]).fn, 't', ['A'])).rejects.toThrow(
      /limite/,
    );
  });
});

describe('Tiny', () => {
  it('confere o token e lê as atualizações de todas as páginas', async () => {
    const ok = fakeFetch([
      { body: { retorno: { status: 'OK', conta: { razao_social: 'Loja da Ana' } } } },
    ]);
    expect(await tinyCheckToken(ok.fn, 'tok')).toBe('Loja da Ana');
    expect(ok.calls[0]!.url).toBe('https://api.tiny.com.br/api2/info.php');
    expect(ok.calls[0]!.init!.body).toBe('token=tok&formato=json');

    await expect(
      tinyCheckToken(
        fakeFetch([{ body: { retorno: { status: 'Erro', erros: [{ erro: 'Token inválido' }] } } }])
          .fn,
        'x',
      ),
    ).rejects.toThrow(/Token inválido/);

    const pages = fakeFetch([
      {
        body: {
          retorno: {
            status: 'OK',
            numero_paginas: 2,
            produtos: [{ produto: { codigo: 'CANECA', saldo: 149 } }],
          },
        },
      },
      {
        body: {
          retorno: {
            status: 'OK',
            numero_paginas: 2,
            produtos: [{ produto: { codigo: 'CAM-P', saldo: '3.000' } }],
          },
        },
      },
    ]);
    expect(await tinyStockUpdates(pages.fn, 'tok', '01/01/2000 00:00:00')).toEqual([
      { sku: 'CANECA', quantity: 149 },
      { sku: 'CAM-P', quantity: 3 },
    ]);
    expect(pages.calls[1]!.init!.body).toBe(
      'token=tok&dataAlteracao=01%2F01%2F2000+00%3A00%3A00&pagina=2&formato=json',
    );
  });

  it('sem registros é lista vazia; outro erro explica a extensão', async () => {
    expect(
      await tinyStockUpdates(
        fakeFetch([{ body: { retorno: { status: 'Erro', codigo_erro: '20' } } }]).fn,
        't',
        'x',
      ),
    ).toEqual([]);
    await expect(
      tinyStockUpdates(
        fakeFetch([{ body: { retorno: { status: 'Erro', codigo_erro: 6, erros: [] } } }]).fn,
        't',
        'x',
      ),
    ).rejects.toThrow(/API para estoque em tempo real/);
  });

  it('cursor no horário de Brasília', () => {
    expect(tinyCursor(new Date('2026-10-01T15:04:05Z'))).toBe('01/10/2026 12:04:05');
  });
});
