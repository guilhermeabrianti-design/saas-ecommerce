import { describeSummary, normalizeQuantity, parseStockCsv, stockTemplateCsv } from './stock-sync';

describe('planilha de estoque', () => {
  it('com cabeçalho em qualquer ordem, separador ; e BOM do Excel', () => {
    const r = parseStockCsv(
      '\uFEFFProduto;Estoque;Código\r\nCaneca;149;CANECA\r\nCamisa;3;CAM-P\r\n',
    );
    expect(r).toEqual({
      rows: [
        { sku: 'CANECA', quantity: '149' },
        { sku: 'CAM-P', quantity: '3' },
      ],
      skipped: [],
      error: null,
    });
  });

  it('sem cabeçalho: SKU e quantidade nas duas primeiras colunas; vírgula e aspas', () => {
    expect(parseStockCsv('"CANECA, AZUL",10\nCAM,2').rows).toEqual([
      { sku: 'CANECA, AZUL', quantity: '10' },
      { sku: 'CAM', quantity: '2' },
    ]);
  });

  it('linhas incompletas são ignoradas e informadas; vazia é erro claro', () => {
    const r = parseStockCsv('sku;quantidade\nA;5\nB;\n;3\nC;1,5\nD;2,0');
    expect(r.rows).toEqual([
      { sku: 'A', quantity: '5' },
      { sku: 'D', quantity: '2' },
    ]);
    expect(r.skipped).toEqual([3, 4, 5]);
    expect(parseStockCsv('   \n').error).toMatch(/vazia/);
    expect(parseStockCsv('sku;quantidade\nA;x').error).toMatch(/Nenhuma linha válida/);
  });

  it('quantidade: inteiro, milhar com ponto, decimal zerado', () => {
    expect(normalizeQuantity('149')).toBe('149');
    expect(normalizeQuantity('1.234')).toBe('1234');
    expect(normalizeQuantity('7,000')).toBe('7');
    expect(normalizeQuantity('-1')).toBeNull();
    expect(normalizeQuantity('1.5')).toBeNull();
  });

  it('modelo com o estoque atual e resumo legível', () => {
    expect(stockTemplateCsv([{ sku: 'A;B', on_hand: 2 }])).toBe('sku;quantidade\r\n"A;B";2');
    expect(
      describeSummary({
        updated: 3,
        unchanged: 1,
        unknown_count: 2,
        unknown: ['X', 'Y'],
        invalid: [],
        clamped: ['Z'],
      }),
    ).toBe(
      '3 atualizado(s) · 1 sem mudança · 2 SKU(s) não encontrado(s) aqui · 1 abaixo do reservado por pedidos',
    );
  });
});
