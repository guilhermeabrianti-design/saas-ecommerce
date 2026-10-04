// @vitest-environment node
import type { PublishData } from '../../supabase/functions/_shared/integrations/mlpublish';
import {
  categoryPath,
  searchCategories,
  suggestionsFromIds,
  variantTiers,
  type CategoryNode,
} from '../../supabase/functions/_shared/integrations/publishcommon';
import {
  buildShopeeItem,
  modelIds,
  parseShopeeAttributes,
  parseShopeeCategories,
  parseShopeeLogistics,
  parseShopeeRecommend,
  shopeeItemStatus,
  shopeeItemUrl,
  tierVariationBody,
  updateItemBody,
  uploadShopeeImage,
} from '../../supabase/functions/_shared/integrations/shopeepublish';
import {
  buildTikTokProduct,
  defaultWarehouse,
  htmlDescription,
  parseTikTokAttributes,
  parseTikTokCategories,
  parseTikTokRecommend,
  tiktokProductStatus,
  tiktokSkuIds,
  uploadTikTokImage,
} from '../../supabase/functions/_shared/integrations/tiktokpublish';

const base = (over: Partial<PublishData> = {}): PublishData => ({
  run_id: 'run',
  action: 'publish',
  provider: 'shopee',
  organization_id: 'org',
  connection_id: 'conn',
  account_id: '880011',
  external_id: null,
  config: {
    title: 'Camiseta Azul',
    price_cents: 5990,
    listing_type: 'padrao',
    category: '100017',
    free_shipping: true,
    attributes: [
      { id: '100134', value_id: '501' },
      { id: '100200', value_name: '10 cm' },
    ],
    variation_map: {},
  },
  product: {
    sku: 'CAM',
    name: 'Camiseta',
    description: 'Camiseta de algodão.\n\nLavar à mão.',
    brand: null,
    gtin: null,
    weight_grams: 250,
    length_mm: 300,
    width_mm: 200,
    height_mm: 25,
    inventory_item_id: 'item-1',
    available: 7,
  },
  variants: [],
  images: ['a.jpg'],
  ...over,
});

const variants: PublishData['variants'] = [
  {
    inventory_item_id: 'v1',
    sku: 'CAM-AZ-P',
    attributes: { Cor: 'Azul', Tamanho: 'P' },
    gtin: null,
    available: 3,
  },
  {
    inventory_item_id: 'v2',
    sku: 'CAM-AZ-M',
    attributes: { Cor: 'Azul', Tamanho: 'M' },
    gtin: null,
    available: 0,
  },
  {
    inventory_item_id: 'v3',
    sku: 'CAM-PR-M',
    attributes: { Cor: 'Preta', Tamanho: 'M' },
    gtin: null,
    available: 5,
  },
];

const tree = new Map<string, CategoryNode>([
  ['1', { id: '1', parent: null, name: 'Moda', leaf: false }],
  ['2', { id: '2', parent: '1', name: 'Roupas Masculinas', leaf: false }],
  ['3', { id: '3', parent: '2', name: 'Camisetas', leaf: true }],
  ['4', { id: '4', parent: '2', name: 'Bermudas', leaf: true }],
]);

describe('peças comuns da publicação', () => {
  it('caminho, sugestões só de categorias finais e busca por palavra', () => {
    expect(categoryPath(tree, '3')).toBe('Moda › Roupas Masculinas › Camisetas');
    expect(suggestionsFromIds(tree, ['2', '3', '3', '99'])).toEqual([
      {
        category_id: '3',
        category_name: 'Moda › Roupas Masculinas › Camisetas',
        domain_name: '',
      },
    ]);
    expect(searchCategories(tree, 'camiseta azul').map((s) => s.category_id)).toEqual(['3']);
    expect(searchCategories(tree, 'ab')).toEqual([]);
  });

  it('características das variações viram níveis', () => {
    const r = variantTiers(base({ variants }), 2, 'A Shopee');
    expect(r).toEqual({
      ok: true,
      tiers: {
        names: ['Cor', 'Tamanho'],
        options: [
          ['Azul', 'Preta'],
          ['P', 'M'],
        ],
        indexes: [
          [0, 0],
          [0, 1],
          [1, 1],
        ],
      },
    });
    const three = variantTiers(
      base({ variants: [{ ...variants[0]!, attributes: { a: '1', b: '2', c: '3' } }] }),
      2,
      'A Shopee',
    );
    expect(three.ok === false && three.errors[0]).toMatch(/até 2 características/);
    const dup = variantTiers(
      base({ variants: [variants[0]!, { ...variants[0]!, sku: 'X' }] }),
      2,
      'A Shopee',
    );
    expect(dup.ok === false && dup.errors[0]).toMatch(/mesma combinação \(X\)/);
    const missing = variantTiers(
      base({ variants: [variants[0]!, { ...variants[1]!, attributes: { Cor: 'Azul' } }] }),
      2,
      'A Shopee',
    );
    expect(missing.ok === false && missing.errors[0]).toMatch(/não tem "Tamanho"/);
  });
});

describe('publicar na Shopee', () => {
  const attrs = parseShopeeAttributes({
    attribute_list: [
      {
        attribute_id: 100134,
        display_attribute_name: 'Material',
        is_mandatory: true,
        input_type: 'DROP_DOWN',
        attribute_value_list: [{ value_id: 501, display_value_name: 'Algodão' }],
      },
      {
        attribute_id: 100200,
        original_attribute_name: 'Comprimento',
        is_mandatory: false,
        input_type: 'TEXT_FILED',
        input_validation_type: 'FLOAT_TYPE',
        attribute_unit: ['cm', 'm'],
      },
    ],
  });
  const logistics = parseShopeeLogistics({
    logistics_channel_list: [
      { logistics_channel_id: 90001, logistics_channel_name: 'Shopee Xpress', enabled: true },
      { logistics_channel_id: 90002, logistics_channel_name: 'Correios', enabled: false },
    ],
  });

  it('lê categorias, recomendação, atributos e canais de envio', () => {
    const nodes = parseShopeeCategories({
      category_list: [
        {
          category_id: 100,
          parent_category_id: 0,
          display_category_name: 'Moda',
          has_children: true,
        },
        {
          category_id: 100017,
          parent_category_id: 100,
          display_category_name: 'Camisetas',
          has_children: false,
        },
      ],
    });
    expect(categoryPath(nodes, '100017')).toBe('Moda › Camisetas');
    expect(parseShopeeRecommend({ category_id: [100017, 'x'] })).toEqual(['100017']);
    expect(attrs).toEqual([
      {
        id: '100134',
        name: 'Material',
        required: true,
        variation: false,
        value_type: 'list',
        values: [{ id: '501', name: 'Algodão' }],
        units: [],
        hint: '',
      },
      {
        id: '100200',
        name: 'Comprimento',
        required: false,
        variation: false,
        value_type: 'number',
        values: [],
        units: [
          { id: 'cm', name: 'cm' },
          { id: 'm', name: 'm' },
        ],
        hint: '',
      },
    ]);
    expect(logistics).toEqual([{ id: 90001, name: 'Shopee Xpress' }]);
  });

  it('monta o anúncio simples', () => {
    const r = buildShopeeItem(base(), ['img1'], attrs, logistics);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.body).toEqual({
      item_name: 'Camiseta Azul',
      description: 'Camiseta de algodão.\n\nLavar à mão.',
      original_price: 59.9,
      seller_stock: [{ stock: 7 }],
      weight: 0.25,
      image: { image_id_list: ['img1'] },
      category_id: 100017,
      attribute_list: [
        { attribute_id: 100134, attribute_value_list: [{ value_id: 501 }] },
        {
          attribute_id: 100200,
          attribute_value_list: [{ value_id: 0, original_value_name: '10', value_unit: 'cm' }],
        },
      ],
      brand: { brand_id: 0, original_brand_name: 'NoBrand' },
      logistic_info: [{ logistic_id: 90001, enabled: true, is_free: true }],
      condition: 'NEW',
      item_status: 'NORMAL',
      item_sku: 'CAM',
      dimension: { package_length: 30, package_width: 20, package_height: 3 },
    });
    expect(r.item.single).toEqual({ sku: 'CAM', inventory_item_id: 'item-1', stock: 7 });
    expect(updateItemBody('55', r.item)).not.toHaveProperty('seller_stock');
    expect(updateItemBody('55', r.item)).toMatchObject({ item_id: 55, item_name: 'Camiseta Azul' });
  });

  it('monta variações (até 2 características)', () => {
    const r = buildShopeeItem(base({ variants }), ['img1'], attrs, logistics);
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.item.body.seller_stock).toEqual([{ stock: 8 }]);
    expect(tierVariationBody('55', r.item)).toEqual({
      item_id: 55,
      tier_variation: [
        { name: 'Cor', option_list: [{ option: 'Azul' }, { option: 'Preta' }] },
        { name: 'Tamanho', option_list: [{ option: 'P' }, { option: 'M' }] },
      ],
      model: [
        {
          tier_index: [0, 0],
          original_price: 59.9,
          model_sku: 'CAM-AZ-P',
          seller_stock: [{ stock: 3 }],
        },
        {
          tier_index: [0, 1],
          original_price: 59.9,
          model_sku: 'CAM-AZ-M',
          seller_stock: [{ stock: 0 }],
        },
        {
          tier_index: [1, 1],
          original_price: 59.9,
          model_sku: 'CAM-PR-M',
          seller_stock: [{ stock: 5 }],
        },
      ],
    });
  });

  it('recusa antes de chamar a Shopee', () => {
    const r = buildShopeeItem(
      base({
        config: { ...base().config, category: null, attributes: [] },
        product: { ...base().product, weight_grams: null },
      }),
      [],
      attrs,
      [],
    );
    expect(r).toEqual({
      ok: false,
      errors: [
        'Escolha a categoria da Shopee.',
        'Adicione ao menos uma foto ao produto.',
        'Informe o peso do produto (a Shopee exige).',
        'Ative ao menos um canal de envio na sua loja da Shopee.',
        'Preencha os atributos obrigatórios: Material.',
      ],
    });
  });

  it('variações, estado e endereço do anúncio', () => {
    expect(
      modelIds({
        model: [
          { model_id: 7, model_sku: 'A' },
          { model_id: 8, model_sku: '' },
        ],
      }),
    ).toEqual(new Map([['A', '7']]));
    expect(shopeeItemStatus('NORMAL')).toBe('active');
    expect(shopeeItemStatus('UNLIST')).toBe('paused');
    expect(shopeeItemStatus('REVIEWING')).toBe('review');
    expect(shopeeItemStatus('BANNED')).toBe('closed');
    expect(shopeeItemUrl('880011', '55')).toBe('https://shopee.com.br/product/880011/55');
    expect(shopeeItemUrl(undefined, '55')).toBeNull();
  });

  it('envia a foto sem loja e lê o image_id', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ error: '', response: { image_info: { image_id: 'br-abc' } } }),
        ),
    );
    const app = { host: 'https://partner.shopeemobile.com', partnerId: '1', partnerKey: 'k' };
    expect(await uploadShopeeImage(fetchFn, app, new Uint8Array([1, 2]), 'image/png')).toBe(
      'br-abc',
    );
    const url = new URL(fetchFn.mock.calls[0]![0]);
    expect(url.pathname).toBe('/api/v2/media_space/upload_image');
    expect(url.searchParams.get('access_token')).toBeNull();
    expect(fetchFn.mock.calls[0]![1]!.body).toBeInstanceOf(FormData);
  });
});

describe('publicar na TikTok Shop', () => {
  const attrs = parseTikTokAttributes({
    attributes: [
      {
        id: '100392',
        name: 'Material',
        type: 'PRODUCT_PROPERTY',
        is_requried: true,
        values: [{ id: '1001', name: 'Algodão' }],
      },
      { id: '100000', name: 'Cor', type: 'SALES_PROPERTY', values: [] },
      {
        id: '100500',
        name: 'Estilo',
        type: 'PRODUCT_PROPERTY',
        is_customizable: true,
        values: [{ id: '7', name: 'Casual' }],
      },
    ],
  });

  it('lê árvore, recomendação, atributos de produto e depósito', () => {
    const nodes = parseTikTokCategories({
      categories: [
        { id: '600001', parent_id: '0', local_name: 'Moda', is_leaf: false },
        { id: '601226', parent_id: '600001', local_name: 'Camisetas', is_leaf: true },
      ],
    });
    expect(categoryPath(nodes, '601226')).toBe('Moda › Camisetas');
    expect(
      parseTikTokRecommend({
        leaf_category_id: '601226',
        categories: [
          { id: '601226', name: 'Camisetas', level: 2, is_leaf: true },
          { id: '600001', name: 'Moda', level: 1, is_leaf: false },
        ],
      }),
    ).toEqual([{ category_id: '601226', category_name: 'Moda › Camisetas', domain_name: '' }]);
    expect(parseTikTokRecommend({})).toEqual([]);
    expect(attrs.map((a) => [a.id, a.required, a.value_type, a.hint])).toEqual([
      ['100392', true, 'list', ''],
      ['100500', false, 'string', 'Ex.: Casual'],
    ]);
    expect(
      defaultWarehouse({
        warehouses: [
          { id: '1', type: 'RETURN_WAREHOUSE', is_default: true },
          { id: '7068', type: 'SALES_WAREHOUSE', is_default: true, effect_status: 'ENABLED' },
        ],
      }),
    ).toBe('7068');
    expect(defaultWarehouse({ warehouses: [] })).toBeNull();
  });

  it('descrição em HTML escapado', () => {
    expect(htmlDescription('Linha <b>1</b>\n\nA & B', 'x')).toBe('<p>Linha 1</p><p>A &amp; B</p>');
    expect(htmlDescription('', 'Título')).toBe('<p>Título</p>');
  });

  it('monta o produto com variações pelo nome', () => {
    const data = base({
      provider: 'tiktok',
      config: {
        ...base().config,
        category: '601226',
        attributes: [
          { id: '100392', value_id: '1001' },
          { id: '100500', value_name: 'Casual' },
        ],
      },
      variants,
    });
    const r = buildTikTokProduct(data, ['uri1'], attrs, '7068', new Map([['CAM-AZ-P', '900']]));
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.item.body).toMatchObject({
      title: 'Camiseta Azul',
      category_id: '601226',
      main_images: [{ uri: 'uri1' }],
      package_weight: { value: '0.250', unit: 'KILOGRAM' },
      package_dimensions: { length: '30', width: '20', height: '3', unit: 'CENTIMETER' },
      product_attributes: [
        { id: '100392', values: [{ id: '1001' }] },
        { id: '100500', values: [{ name: 'Casual' }] },
      ],
    });
    expect((r.item.body.skus as unknown[])[0]).toEqual({
      id: '900',
      seller_sku: 'CAM-AZ-P',
      price: { amount: '59.90', currency: 'BRL' },
      inventory: [{ warehouse_id: '7068', quantity: 3 }],
      sales_attributes: [
        { name: 'Cor', value_name: 'Azul' },
        { name: 'Tamanho', value_name: 'P' },
      ],
    });
    expect(r.item.links.map((l) => l.sku)).toEqual(['CAM-AZ-P', 'CAM-AZ-M', 'CAM-PR-M']);
  });

  it('recusa sem categoria, foto, peso, depósito e obrigatórios', () => {
    const r = buildTikTokProduct(
      base({
        config: { ...base().config, category: 'MLB1', attributes: [] },
        product: { ...base().product, weight_grams: 0 },
      }),
      [],
      attrs,
      null,
    );
    expect(r).toEqual({
      ok: false,
      errors: [
        'Escolha a categoria da TikTok Shop.',
        'Adicione ao menos uma foto ao produto.',
        'Informe o peso do produto (a TikTok Shop exige).',
        'A loja da TikTok Shop não tem depósito de venda ativo.',
        'Preencha os atributos obrigatórios: Material.',
      ],
    });
  });

  it('SKUs, estado e envio de foto', async () => {
    expect(
      tiktokSkuIds({
        skus: [
          { id: '900', seller_sku: 'A' },
          { id: 'x', seller_sku: 'B' },
        ],
      }),
    ).toEqual(new Map([['A', '900']]));
    expect(tiktokProductStatus('ACTIVATE')).toBe('active');
    expect(tiktokProductStatus('PENDING')).toBe('review');
    expect(tiktokProductStatus('SELLER_DEACTIVATED')).toBe('paused');
    expect(tiktokProductStatus('DELETED')).toBe('closed');

    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ code: 0, data: { uri: 'tos-maliva-i-o/abc' } })),
    );
    const app = { appKey: 'k', appSecret: 's', serviceId: '1' };
    expect(await uploadTikTokImage(fetchFn, app, 'tok', new Uint8Array([1]), 'image/jpeg')).toBe(
      'tos-maliva-i-o/abc',
    );
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(new URL(url).pathname).toBe('/product/202309/images/upload');
    expect((init!.headers as Record<string, string>)['x-tts-access-token']).toBe('tok');
    const form = init!.body as FormData;
    expect(form.get('use_case')).toBe('MAIN_IMAGE');
  });
});
