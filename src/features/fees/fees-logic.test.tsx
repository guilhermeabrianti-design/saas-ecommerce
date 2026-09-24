import { render, screen } from '@testing-library/react';
import { formatBRL } from '@/utils/money';
import { SplitBreakdown } from './components/SplitCalculator';
import {
  bpsToInput,
  categoryPath,
  describeBand,
  feeOptions,
  feeRuleFormSchema,
  feesAuditLabels,
  feesErrorMessage,
  formatBps,
  parsePercentToBps,
  sortCategories,
  toFeeRuleFormValues,
  toFeeRulePayload,
  type Category,
  type FeeRule,
  type Split,
} from './fees';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const rule = (over: Partial<FeeRule>): FeeRule => ({
  id: uuid(1),
  provider: 'tiktok',
  listing_type: 'padrao',
  label: 'Padrão',
  category_id: null,
  campaign: null,
  min_unit_price_cents: 0,
  max_unit_price_cents: null,
  percent_bps: 1000,
  fixed_cents_per_item: 0,
  is_active: true,
  notes: null,
  updated_at: '2026-09-23T00:00:00Z',
  ...over,
});

describe('percentuais', () => {
  it('converte o que a pessoa digita em pontos-base', () => {
    expect(parsePercentToBps('15')).toBe(1500);
    expect(parsePercentToBps('14,5')).toBe(1450);
    expect(parsePercentToBps('2.99%')).toBe(299);
    expect(parsePercentToBps(' 0 ')).toBe(0);
    expect(parsePercentToBps('100')).toBe(10000);
    for (const bad of ['', '100,01', '-1', 'abc', '1,234', '15%%']) {
      expect(parsePercentToBps(bad)).toBeNull();
    }
  });

  it('formata e volta ao campo', () => {
    expect(formatBps(1500)).toBe('15%');
    expect(formatBps(1450)).toBe('14,5%');
    expect(formatBps(299)).toBe('2,99%');
    expect(bpsToInput(1450)).toBe('14,5');
    expect(bpsToInput(null)).toBe('');
    expect(parsePercentToBps(bpsToInput(299))).toBe(299);
  });
});

describe('opções de marketplace', () => {
  it('só oferece tipos com regra base ativa, com as campanhas de cada tipo', () => {
    const options = feeOptions([
      rule({ id: uuid(1) }),
      rule({ id: uuid(2), min_unit_price_cents: 5000 }),
      rule({ id: uuid(3), provider: 'shopee', listing_type: 'live', label: 'Live' }),
      rule({ id: uuid(4), provider: 'shopee', listing_type: 'live', campaign: 'extra' }),
      rule({ id: uuid(5), provider: 'mercadolivre', listing_type: 'classico', is_active: false }),
      rule({ id: uuid(6), provider: 'shopee', listing_type: 'padrao', campaign: 'so-campanha' }),
    ]);
    expect(options).toEqual([
      { provider: 'shopee', types: [{ value: 'live', label: 'Live', campaigns: ['extra'] }] },
      { provider: 'tiktok', types: [{ value: 'padrao', label: 'Padrão', campaigns: [] }] },
    ]);
  });

  it('descreve a faixa de preço', () => {
    expect(describeBand(0, null, formatBRL)).toBe('Qualquer preço');
    expect(describeBand(0, 5000, formatBRL)).toMatch(/^Abaixo de R\$\s50,00$/);
    expect(describeBand(5000, null, formatBRL)).toMatch(/^A partir de R\$\s50,00$/);
    expect(describeBand(100, 200, formatBRL)).toMatch(/^De R\$\s1,00 até abaixo de R\$\s2,00$/);
  });
});

describe('formulário de regra de taxa', () => {
  it('ida e volta mantém os valores', () => {
    const r = rule({
      listing_type: 'padrao',
      min_unit_price_cents: 5000,
      percent_bps: 600,
      fixed_cents_per_item: 600,
      notes: 'Tabela oficial',
    });
    const values = feeRuleFormSchema.parse(toFeeRuleFormValues(r));
    expect(toFeeRulePayload(values)).toEqual({
      provider: 'tiktok',
      listing_type: 'padrao',
      label: 'Padrão',
      category_id: null,
      campaign: null,
      min_unit_price_cents: 5000,
      max_unit_price_cents: null,
      percent_bps: 600,
      fixed_cents_per_item: 600,
      is_active: true,
      notes: 'Tabela oficial',
    });
  });

  it('valida código, percentual e faixa', () => {
    const base = toFeeRuleFormValues(null);
    const ok = { ...base, listingType: 'Classico', label: 'Clássico', percent: '14' };
    expect(feeRuleFormSchema.parse(ok).listingType).toBe('classico');
    expect(feeRuleFormSchema.safeParse({ ...ok, listingType: 'com espaço' }).success).toBe(false);
    expect(feeRuleFormSchema.safeParse({ ...ok, percent: '101' }).success).toBe(false);
    expect(feeRuleFormSchema.safeParse({ ...ok, minPrice: '50', maxPrice: '50' }).success).toBe(
      false,
    );
    expect(feeRuleFormSchema.safeParse({ ...ok, fixed: 'abc' }).success).toBe(false);
  });
});

describe('categorias', () => {
  const cats: Category[] = [
    { id: uuid(1), parent_id: null, name: 'Moda', is_active: true },
    { id: uuid(2), parent_id: uuid(3), name: 'Relógios', is_active: true },
    { id: uuid(3), parent_id: null, name: 'Eletrônicos', is_active: true },
    { id: uuid(4), parent_id: uuid(3), name: 'Áudio', is_active: false },
  ];

  it('ordena como árvore e mostra o caminho', () => {
    expect(sortCategories(cats).map((c) => c.name)).toEqual([
      'Eletrônicos',
      'Áudio',
      'Relógios',
      'Moda',
    ]);
    expect(categoryPath(cats[1]!, cats)).toBe('Eletrônicos › Relógios');
    expect(categoryPath(cats[0]!, cats)).toBe('Moda');
  });
});

describe('mensagens', () => {
  it('traduz os erros de taxas e rotula a auditoria', () => {
    for (const code of [
      'fees.invalid',
      'fees.not_found',
      'fees.no_change',
      'fees.overlap',
      'fees.duplicate',
      'fees.invalid_parent',
      'fees.default_required',
      'fees.category_inactive',
      'fees.forbidden',
      'fees.not_configured',
      'fees.campaign_not_configured',
      'fees.commission_not_configured',
    ]) {
      expect(feesErrorMessage({ message: code })).not.toContain('fees.');
      expect(feesErrorMessage({ message: code })).not.toMatch(/Tente novamente/);
    }
    expect(Object.keys(feesAuditLabels)).toHaveLength(8);
  });
});

describe('demonstrativo da divisão', () => {
  const split: Split = {
    unit_price_cents: 10000,
    quantity: 1,
    sale_cents: 10000,
    marketplace_fee_cents: 1600,
    fee_rule: { id: uuid(1), label: 'Clássico', percent_bps: 1600, fixed_cents_per_item: 0 },
    campaign_rule: null,
    supplier_cents: 4000,
    seller_commission_bps: 1500,
    seller_commission_source: 'default',
    seller_commission_cents: 1500,
    platform_cents: 2900,
    platform_margin_bps: 2900,
  };

  it('mostra venda, taxas, fornecedor, vendedor e receita da TheSigns', () => {
    render(<SplitBreakdown split={split} />);
    const row = (label: string) => screen.getByText(label).closest('div')!.textContent;
    expect(row('Preço de venda')).toMatch(/100,00/);
    expect(row('Taxas do marketplace')).toMatch(/Clássico: 16%.*16,00/);
    expect(row('Custo do fornecedor')).toMatch(/40,00/);
    expect(row('Comissão do vendedor')).toMatch(/15% · comissão padrão.*15,00/);
    expect(row('Receita estimada da TheSigns')).toMatch(/29,00/);
    expect(screen.getByText('Margem TheSigns').nextSibling?.textContent).toBe('29%');
    expect(screen.queryByText(/prejuízo/)).toBeNull();
  });

  it('avisa quando a plataforma fica no prejuízo', () => {
    render(
      <SplitBreakdown split={{ ...split, platform_cents: -500, platform_margin_bps: -500 }} />,
    );
    expect(screen.getByRole('alert').textContent).toMatch(/prejuízo/);
  });
});
