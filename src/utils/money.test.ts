import { centsToInput, formatBRL, parseBRL } from './money';

describe('parseBRL', () => {
  it.each([
    ['49,90', 4990],
    ['49,9', 4990],
    ['1.234,56', 123456],
    ['R$ 10', 1000],
    ['r$10,00', 1000],
    ['1234', 123400],
    ['1.234', 123400],
    ['49.9', 4990],
    ['0,01', 1],
    ['0', 0],
  ])('%s → %i centavos', (input, cents) => {
    expect(parseBRL(input)).toBe(cents);
  });

  it.each(['', 'abc', '-5', '1,234,5', '10,999', '12.34.5', '1.23,45', '1e3'])(
    'rejeita %j',
    (input) => {
      expect(parseBRL(input)).toBeNull();
    },
  );

  it('não sofre arredondamento de ponto flutuante', () => {
    // 0.29 * 100 === 28.999999999999996 in floating point
    expect(parseBRL('0,29')).toBe(29);
    expect(parseBRL('1.000.000,07')).toBe(100000007);
  });
});

describe('centsToInput / formatBRL', () => {
  it('ida e volta sem perda', () => {
    for (const cents of [0, 1, 29, 4990, 123456]) {
      expect(parseBRL(centsToInput(cents))).toBe(cents);
    }
  });

  it('formata em reais', () => {
    expect(formatBRL(123456).replace(/\s/g, ' ')).toBe('R$ 1.234,56');
    expect(centsToInput(null)).toBe('');
  });
});
