import {
  attributeDraft,
  attributesPayload,
  missingRequired,
  mlPublishErrorMessage,
  publishErrorMessage,
  publishStatusInfo,
  variantKeys,
  variationMapDraft,
  type MlAttribute,
} from './ml-publish';

const attr = (over: Partial<MlAttribute> & { id: string }): MlAttribute => ({
  name: over.id,
  required: false,
  variation: false,
  value_type: 'string',
  values: [],
  units: [],
  hint: '',
  ...over,
});

const attrs: MlAttribute[] = [
  attr({ id: 'BRAND', name: 'Marca', required: true }),
  attr({ id: 'GTIN', name: 'Código universal', required: true }),
  attr({ id: 'MODEL', name: 'Modelo', required: true }),
  attr({
    id: 'COLOR',
    name: 'Cor',
    variation: true,
    values: [{ id: '52049', name: 'Azul' }],
  }),
  attr({ id: 'SIZE', name: 'Tamanho', variation: true }),
  attr({ id: 'MATERIAL', name: 'Material' }),
];

describe('atributos na tela', () => {
  it('rascunho ↔ envio: só da categoria, com valor; da lista leva id e nome', () => {
    const draft = attributeDraft([
      { id: 'MODEL', value_name: 'Básica' },
      { id: 'OLD_CATEGORY_ATTR', value_name: 'x' },
    ]);
    draft.COLOR = { value_id: '52049' };
    draft.MATERIAL = { value_name: '   ' };
    expect(attributesPayload(draft, attrs)).toEqual([
      { id: 'MODEL', value_name: 'Básica' },
      { id: 'COLOR', value_id: '52049', value_name: 'Azul' },
    ]);
  });

  it('obrigatórios: marca e GTIN do produto contam, variação mapeada conta', () => {
    const missing = (product: { brand: string | null; gtin: string | null }, map = {}) =>
      missingRequired(attrs, {}, product, map).map((a) => a.id);
    expect(missing({ brand: null, gtin: null })).toEqual(['BRAND', 'GTIN', 'MODEL']);
    expect(missing({ brand: 'X', gtin: '7891234567895' })).toEqual(['MODEL']);
    expect(missing({ brand: 'X', gtin: null }, { Modelo: 'MODEL' })).toEqual(['GTIN']);
    expect(
      missingRequired(
        attrs,
        { EMPTY_GTIN_REASON: { value_id: '1' } },
        { brand: 'X', gtin: null },
        {},
      ).map((a) => a.id),
    ).toEqual(['MODEL']);
  });

  it('mapa das variações: salvo vence; palpite pelo nome ou apelido; só atributos de variação', () => {
    expect(variationMapDraft(['Cor', 'Tamanho', 'Material'], attrs, {})).toEqual({
      Cor: 'COLOR',
      Tamanho: 'SIZE',
    });
    expect(variationMapDraft(['Tom'], attrs, { Tom: 'COLOR' })).toEqual({ Tom: 'COLOR' });
    // Salvo que não aceita variação nesta categoria é descartado.
    expect(variationMapDraft(['Tom'], attrs, { Tom: 'MATERIAL' })).toEqual({});
    expect(
      variantKeys([
        { attributes: { Cor: 'Azul', Tamanho: 'P' }, is_active: true },
        { attributes: { Voltagem: '220V' }, is_active: false },
      ]),
    ).toEqual(['Cor', 'Tamanho']);
  });

  it('mensagens de erro', () => {
    expect(mlPublishErrorMessage('ml.not_connected')).toMatch(/Integrações/);
    expect(mlPublishErrorMessage(null, 'Mercado Livre: limite')).toBe('Mercado Livre: limite');
    expect(mlPublishErrorMessage('???')).toMatch(/Tente de novo/);
  });

  it('Shopee e TikTok Shop: estado e erros com o nome do canal', () => {
    expect(publishStatusInfo('shopee', 'review')).toEqual({
      label: 'Em análise na Shopee',
      tone: 'warn',
    });
    expect(publishStatusInfo('mercadolivre', 'active').label).toBe('Ativo no Mercado Livre');
    expect(publishStatusInfo('tiktok', null).label).toBe('Ainda não publicado');
    expect(publishErrorMessage('publish.not_connected', null, 'tiktok')).toBe(
      'Conecte sua loja da TikTok Shop em Integrações antes de publicar.',
    );
    expect(publishErrorMessage('ml.busy')).toMatch(/em andamento/);
    expect(publishErrorMessage('not_configured', null, 'shopee')).toMatch(/com a Shopee/);
    expect(publishErrorMessage(null, null, 'tiktok')).toBe(
      'Não foi possível falar com a TikTok Shop. Tente de novo.',
    );
  });
});
