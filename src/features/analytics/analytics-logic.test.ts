import { analyticsErrorMessage, barHeights, shortDay } from './api';

describe('altura das barras', () => {
  it('escala pelo maior valor e nunca esconde valor positivo', () => {
    expect(barHeights([0, 50, 100])).toEqual([0, 50, 100]);
    expect(barHeights([1, 10000])).toEqual([2, 100]);
  });

  it('tudo zero ou vazio não gera altura', () => {
    expect(barHeights([0, 0])).toEqual([0, 0]);
    expect(barHeights([])).toEqual([]);
  });
});

describe('rótulos', () => {
  it('formata o dia sem deslocamento de fuso', () => {
    expect(shortDay('2026-09-01')).toBe('01/09');
    expect(shortDay('2026-12-31')).toBe('31/12');
  });

  it('traduz erro de período e cai nos erros de organização', () => {
    expect(analyticsErrorMessage({ message: 'analytics.invalid_period' })).toBe(
      'Período inválido.',
    );
    expect(analyticsErrorMessage({ message: 'org.forbidden' })).not.toMatch(/analytics/);
  });
});
