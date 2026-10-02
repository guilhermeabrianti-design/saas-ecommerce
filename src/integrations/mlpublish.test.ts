// @vitest-environment node
import {
  buildMlItem,
  buildMlUpdate,
  existingVariationSkus,
  mlErrorMessage,
  mlSend,
  parseCategoryAttributes,
  parseCategorySuggestions,
  parseItem,
  plainDescription,
  publishStatus,
  type MlCategoryAttribute,
  type PublishData,
} from '../../supabase/functions/_shared/integrations/mlpublish';
import { StockPushError } from '../../supabase/functions/_shared/integrations/stock';

const base = (over: Partial<PublishData> = {}): PublishData => ({
  run_id: '11111111-2222-4333-8444-555555555555',
  action: 'publish',
  organization_id: '11111111-2222-4333-8444-555555555556',
  connection_id: '11111111-2222-4333-8444-555555555557',
  external_id: null,
  config: {
    title: 'Camiseta Azul',
    price_cents: 8990,
    listing_type: 'classico',
    category: 'MLB31447',
    free_shipping: true,
    attributes: [{ id: 'MODEL', value_name: 'Básica' }],
    variation_map: {},
  },
  product: {
    sku: 'CAM',
    name: 'Camiseta',
    description: '<p>Algodão</p>\r\n\r\n\r\n100%',
    brand: 'Marca X',
    gtin: '7891234567895',
    inventory_item_id: 'item-1',
    available: 7,
  },
  variants: [],
  images: ['a.jpg'],
  ...over,
});

const required = (id: string, name = id, variation = false): MlCategoryAttribute => ({
  id,
  name,
  required: true,
  variation,
  value_type: 'string',
  values: [],
  units: [],
  hint: '',
});

describe('categorias e atributos', () => {
  it('sugestões válidas, sem repetir', () => {
    expect(
      parseCategorySuggestions([
        { category_id: 'MLB31447', category_name: 'Camisetas', domain_name: 'Camisetas' },
        { category_id: 'MLB31447', category_name: 'dup' },
        { category_id: 'X1', category_name: 'inválida' },
        null,
      ]),
    ).toEqual([{ category_id: 'MLB31447', category_name: 'Camisetas', domain_name: 'Camisetas' }]);
    expect(parseCategorySuggestions({})).toEqual([]);
  });

  it('atributos: obrigatórios primeiro; escondidos, só leitura e automáticos saem', () => {
    const attrs = parseCategoryAttributes([
      {
        id: 'COLOR',
        name: 'Cor',
        tags: { allow_variations: true },
        values: [{ id: '52049', name: 'Azul' }],
      },
      { id: 'BRAND', name: 'Marca', tags: { required: true } },
      { id: 'SELLER_SKU', name: 'SKU', tags: {} },
      { id: 'HIDDEN', name: 'x', tags: { hidden: true } },
      { id: 'RO', name: 'x', tags: { read_only: true } },
      { id: 'GTIN', name: 'Código universal', tags: { catalog_required: true } },
      { id: 'bad id', name: 'x' },
    ]);
    expect(attrs.map((a) => [a.id, a.required, a.variation])).toEqual([
      ['BRAND', true, false],
      ['GTIN', true, false],
      ['COLOR', false, true],
    ]);
    expect(attrs[2]!.values).toEqual([{ id: '52049', name: 'Azul' }]);
  });
});

describe('montagem do anúncio', () => {
  it('produto simples: preço, estoque, SKU, marca e GTIN automáticos', () => {
    const r = buildMlItem(base(), ['https://x/a.jpg'], [required('BRAND'), required('MODEL')]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.body).toMatchObject({
      title: 'Camiseta Azul',
      category_id: 'MLB31447',
      currency_id: 'BRL',
      condition: 'new',
      listing_type_id: 'gold_special',
      price: 89.9,
      available_quantity: 7,
      pictures: [{ source: 'https://x/a.jpg' }],
      shipping: { mode: 'me2', free_shipping: true },
    });
    expect(r.item.body.attributes).toEqual([
      { id: 'MODEL', value_name: 'Básica' },
      { id: 'BRAND', value_name: 'Marca X' },
      { id: 'GTIN', value_name: '7891234567895' },
      { id: 'SELLER_SKU', value_name: 'CAM' },
    ]);
    expect(r.item.links).toEqual([{ inventory_item_id: 'item-1', sku: 'CAM' }]);
    expect(r.item.description).toBe('Algodão\n\n100%');
  });

  it('recusa antes da API: sem foto, sem estoque, obrigatório faltando, tipo desconhecido', () => {
    const r = buildMlItem(
      base({
        config: { ...base().config, listing_type: 'ouro', category: null },
        product: { ...base().product, available: 0, brand: null },
      }),
      [],
      [required('BRAND', 'Marca'), required('MODEL')],
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      'Tipo de anúncio "ouro" não existe no Mercado Livre.',
      'Escolha a categoria do Mercado Livre.',
      'Adicione ao menos uma foto ao produto.',
      'Sem estoque disponível para anunciar.',
      'Preencha os atributos obrigatórios: Marca.',
    ]);
  });

  it('GTIN obrigatório aceita o motivo de não ter código', () => {
    const data = base({
      product: { ...base().product, gtin: null },
      config: { ...base().config, attributes: [{ id: 'EMPTY_GTIN_REASON', value_id: '17055161' }] },
    });
    expect(buildMlItem(data, ['https://x/a.jpg'], [required('GTIN')]).ok).toBe(true);
  });

  const variants = (): PublishData['variants'] => [
    {
      inventory_item_id: 'v1',
      sku: 'CAM-P',
      attributes: { Cor: 'Azul', Tamanho: 'P' },
      gtin: null,
      available: 3,
    },
    {
      inventory_item_id: 'v2',
      sku: 'CAM-M',
      attributes: { Cor: 'Azul', Tamanho: 'M' },
      gtin: '7891234567888',
      available: 0,
    },
  ];

  it('variações: precisam do mapa; mesmo preço; nova sem estoque fica de fora', () => {
    const unmapped = buildMlItem(
      base({ variants: variants(), config: { ...base().config, variation_map: { Cor: 'COLOR' } } }),
      ['https://x/a.jpg'],
      [],
    );
    expect(unmapped).toEqual({
      ok: false,
      errors: ['Associe "Tamanho" a um atributo de variação do Mercado Livre.'],
    });

    const r = buildMlItem(
      base({
        variants: variants(),
        config: { ...base().config, variation_map: { Cor: 'COLOR', Tamanho: 'SIZE' } },
      }),
      ['https://x/a.jpg'],
      [required('COLOR', 'Cor', true), required('SIZE', 'Tamanho', true)],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.body.price).toBeUndefined();
    expect(r.item.body.variations).toEqual([
      {
        attribute_combinations: [
          { id: 'COLOR', value_name: 'Azul' },
          { id: 'SIZE', value_name: 'P' },
        ],
        price: 89.9,
        available_quantity: 3,
        picture_ids: ['https://x/a.jpg'],
        attributes: [
          { id: 'SELLER_SKU', value_name: 'CAM-P' },
          { id: 'GTIN', value_name: '7891234567895' },
        ],
      },
    ]);
    expect(r.item.skipped).toEqual(['CAM-M']);
    expect(r.item.links).toEqual([{ inventory_item_id: 'v1', sku: 'CAM-P' }]);
    // SKU do produto só vai nas variações.
    expect(r.item.body.attributes).not.toContainEqual({ id: 'SELLER_SKU', value_name: 'CAM' });
  });

  it('variação já publicada continua mesmo com estoque zero', () => {
    const r = buildMlItem(
      base({
        external_id: 'MLB1',
        variants: variants(),
        config: { ...base().config, variation_map: { Cor: 'COLOR', Tamanho: 'SIZE' } },
      }),
      ['https://x/a.jpg'],
      [],
      { existingVariationSkus: ['CAM-M'] },
    );
    expect(r.ok && r.item.links.map((l) => l.sku)).toEqual(['CAM-P', 'CAM-M']);
  });

  it('duas variações com a mesma combinação são recusadas', () => {
    const r = buildMlItem(
      base({
        variants: [
          {
            inventory_item_id: 'v1',
            sku: 'A',
            attributes: { Cor: 'Azul' },
            gtin: null,
            available: 1,
          },
          {
            inventory_item_id: 'v2',
            sku: 'B',
            attributes: { Tom: 'Azul' },
            gtin: null,
            available: 1,
          },
        ],
        config: { ...base().config, variation_map: { Cor: 'COLOR', Tom: 'COLOR' } },
      }),
      ['https://x/a.jpg'],
      [],
    );
    expect(r.ok).toBe(false);
  });
});

describe('atualização', () => {
  it('casa variações pelo SKU, título só sem vendas, sem categoria nem tipo', () => {
    const built = buildMlItem(
      base({
        external_id: 'MLB1',
        variants: [
          {
            inventory_item_id: 'v1',
            sku: 'CAM-P',
            attributes: { Cor: 'Azul' },
            gtin: null,
            available: 2,
          },
          {
            inventory_item_id: 'v3',
            sku: 'CAM-G',
            attributes: { Cor: 'Verde' },
            gtin: null,
            available: 4,
          },
        ],
        config: { ...base().config, variation_map: { Cor: 'COLOR' } },
      }),
      ['https://x/a.jpg'],
      [],
    );
    if (!built.ok) throw new Error('esperava ok');
    const existing = {
      sold_quantity: 3,
      variations: [{ id: 987, attributes: [{ id: 'SELLER_SKU', value_name: 'CAM-P' }] }],
    };
    expect(existingVariationSkus(existing)).toEqual(['CAM-P']);
    const body = buildMlUpdate(existing, built.item);
    expect(body.title).toBeUndefined();
    expect(body.category_id).toBeUndefined();
    expect(body.listing_type_id).toBeUndefined();
    const vars = body.variations as Record<string, unknown>[];
    expect(vars[0]).toMatchObject({ id: 987, available_quantity: 2, price: 89.9 });
    expect(vars[0]!.attribute_combinations).toBeUndefined();
    expect(vars[1]).toMatchObject({ available_quantity: 4 });
    expect(vars[1]!.id).toBeUndefined();

    const simple = buildMlItem(base({ external_id: 'MLB1' }), ['https://x/a.jpg'], []);
    if (!simple.ok) throw new Error('esperava ok');
    expect(buildMlUpdate({ sold_quantity: 0 }, simple.item)).toMatchObject({
      title: 'Camiseta Azul',
      price: 89.9,
      available_quantity: 7,
    });
  });
});

describe('respostas e erros da API', () => {
  it('item, status e mensagens', () => {
    expect(
      parseItem({ id: 'MLB123', permalink: 'https://produto.mercadolivre.com.br/MLB-123' }),
    ).toEqual({
      id: 'MLB123',
      permalink: 'https://produto.mercadolivre.com.br/MLB-123',
    });
    expect(parseItem({ id: 'MLB1', permalink: 'javascript:alert(1)' }).permalink).toBeNull();
    expect(() => parseItem({})).toThrow(StockPushError);
    expect(publishStatus({ status: 'active' })).toBe('active');
    expect(publishStatus({ status: 'under_review' })).toBe('paused');
    expect(publishStatus({ status: 'closed' })).toBe('closed');
    expect(
      mlErrorMessage(400, {
        message: 'Validation error',
        cause: [
          { type: 'error', message: 'Attribute BRAND is required' },
          { type: 'warning', message: 'ignorar' },
        ],
      }),
    ).toBe('Mercado Livre: Validation error · Attribute BRAND is required');
    expect(mlErrorMessage(500, null)).toBe('Mercado Livre: HTTP 500');
    expect(plainDescription('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('mlSend: token opcional, erro com causa, 401 pede reconexão', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const ok = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ id: 'MLB1' }), { status: 201 });
    }) as typeof fetch;
    await mlSend(ok, 'tok', 'POST', '/items', { a: 1 });
    expect(calls[0]![0]).toBe('https://api.mercadolibre.com/items');
    expect((calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer tok');
    await mlSend(ok, null, 'GET', '/categories/MLB1');
    expect((calls[1]![1]!.headers as Record<string, string>).authorization).toBeUndefined();

    const fail = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    await expect(mlSend(fail(401, {}), 't', 'GET', '/x')).rejects.toThrow(/reconecte/);
    await expect(
      mlSend(fail(403, { message: 'seller not allowed in category' }), 't', 'GET', '/x'),
    ).rejects.toThrow('Mercado Livre: seller not allowed in category');
  });
});
