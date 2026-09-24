import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { profileFormSchema, signUpSchema } from '@/features/auth/schemas';
import { formatDocument, formatPhone, isValidPhone } from '@/utils/br';
import { OnboardingChecklist } from './components/OnboardingChecklist';
import { SellerDashboard } from './components/SellerDashboard';
import {
  channelLabel,
  onboardingProgress,
  onboardingStepKeys,
  onboardingSteps,
  periodLabel,
  shares,
  summaryCards,
  type OnboardingStep,
} from './dashboard';

const mocks = vi.hoisted(() => ({
  onboarding: [] as { key: string; done: boolean }[],
  summaryCalls: 0,
}));

vi.mock('./api', () => ({
  useOnboarding: () => ({ isPending: false, isError: false, data: mocks.onboarding }),
  useSellerDashboard: () => {
    mocks.summaryCalls += 1;
    return { isPending: true };
  },
  useSeries: () => ({ isPending: true }),
  useChannels: () => ({ isPending: true }),
  useSuggestions: () => ({ isPending: false, isError: false, data: [] }),
  dashboardErrorMessage: () => 'erro',
}));

const ORG = '11111111-2222-4333-8444-555555555555';

describe('telefone e documento', () => {
  it('telefone: DDD sem zero, fixo 2–8 ou celular com 9', () => {
    expect(isValidPhone('(11) 91234-5678')).toBe(true);
    expect(isValidPhone('11 3333-4444')).toBe(true);
    expect(isValidPhone('11812345678')).toBe(false);
    expect(isValidPhone('0112345678')).toBe(false);
    expect(isValidPhone('1191234567')).toBe(false);
    expect(isValidPhone('119123456789')).toBe(false);
  });

  it('formata telefone e documento só quando completos', () => {
    expect(formatPhone('11912345678')).toBe('(11) 91234-5678');
    expect(formatPhone('1133334444')).toBe('(11) 3333-4444');
    expect(formatPhone('119')).toBe('119');
    expect(formatDocument('52998224725')).toBe('529.982.247-25');
    expect(formatDocument('11222333000181')).toBe('11.222.333/0001-81');
  });

  it('cadastro exige telefone e CPF/CNPJ válidos; Minha conta aceita em branco', () => {
    const base = {
      fullName: 'Ana Souza',
      email: 'ana@example.com',
      password: 'Senha12345',
      confirmPassword: 'Senha12345',
      accountType: 'seller',
    };
    expect(
      signUpSchema.safeParse({ ...base, phone: '11912345678', document: '52998224725' }).success,
    ).toBe(true);
    const bad = signUpSchema.safeParse({ ...base, phone: '', document: '52998224724' });
    expect(bad.error?.issues.map((i) => i.path[0])).toEqual(['phone', 'document']);

    expect(profileFormSchema.safeParse({ fullName: 'Ana', phone: '', document: '' }).success).toBe(
      true,
    );
    expect(
      profileFormSchema.safeParse({ fullName: 'Ana', phone: '123', document: '' }).success,
    ).toBe(false);
  });
});

describe('regras do painel', () => {
  it('progresso e próximo passo', () => {
    const steps: OnboardingStep[] = [
      { key: 'profile', done: true },
      { key: 'products', done: false },
      { key: 'channel', done: false },
    ];
    expect(onboardingProgress(steps)).toEqual({
      done: 1,
      total: 3,
      percent: 33,
      complete: false,
      next: 'products',
    });
    expect(onboardingProgress([{ key: 'profile', done: true }])).toMatchObject({
      complete: true,
      next: null,
    });
    // Todo passo que o banco devolve tem texto e destino.
    for (const k of onboardingStepKeys) expect(onboardingSteps[k].to).toMatch(/^\//);
  });

  it('fatias por canal somam 100', () => {
    expect(shares([1, 1, 1])).toEqual([34, 33, 33]);
    expect(shares([6000, 3000])).toEqual([67, 33]);
    expect(shares([0, 0])).toEqual([0, 0]);
    expect(shares([5]).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('rótulos de período e canal', () => {
    expect(periodLabel('2026-09-21', 'week')).toBe('21/09');
    expect(periodLabel('2026-09-01', 'month')).toBe('09/2026');
    expect(channelLabel('manual')).toBe('Pedido manual');
    expect(channelLabel('mercadolivre')).toBe('Mercado Livre');
    expect(channelLabel('desconhecido')).toBe('desconhecido');
  });

  it('cartões: vendi, ganhei, recebido, a receber, a pagar', () => {
    const cards = summaryCards({
      days: 30,
      orders: 2,
      sold_cents: 9000,
      gross_profit_cents: -100,
      units_without_cost: 3,
      received_cents: 6500,
      receivable_cents: 2500,
      receivable_orders: 1,
      payable_cents: 4000,
      payable_orders: 1,
    });
    expect(cards.map((c) => c.label)).toEqual([
      'Quanto vendi',
      'Quanto ganhei (lucro bruto)',
      'Recebido',
      'Tenho a receber',
      'A pagar a fornecedores',
    ]);
    expect(cards[1]).toMatchObject({ tone: 'bad' });
    expect(cards[1]!.hint).toMatch(/3 un\. sem custo/);
    expect(cards[3]!.value).toMatch(/25,00/);
  });
});

describe('telas', () => {
  const renderIn = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

  it('checklist mostra os passos e destaca o próximo', () => {
    mocks.onboarding = [
      { key: 'profile', done: true },
      { key: 'products', done: false },
      { key: 'first_order', done: false },
    ];
    renderIn(<OnboardingChecklist orgId={ORG} />);
    expect(screen.getByText('1 de 3 concluídos')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '33');
    const items = screen.getAllByRole('listitem');
    expect(within(items[0]!).queryByRole('link')).toBeNull();
    expect(within(items[1]!).getByRole('link', { name: /Ver catálogo/ })).toHaveAttribute(
      'href',
      '/catalogo',
    );
    expect(within(items[1]!).getByRole('link')).toHaveClass('bg-brand');
    expect(within(items[2]!).getByRole('link')).not.toHaveClass('bg-brand');
  });

  it('checklist some quando tudo está feito', () => {
    mocks.onboarding = [{ key: 'profile', done: true }];
    const { container } = renderIn(<OnboardingChecklist orgId={ORG} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('membro não consulta valores, só sugestões', () => {
    mocks.summaryCalls = 0;
    renderIn(<SellerDashboard orgId={ORG} role="member" />);
    expect(screen.getByText(/apenas para proprietários e administradores/)).toBeInTheDocument();
    expect(screen.getByText('O que vender')).toBeInTheDocument();
    expect(mocks.summaryCalls).toBe(0);
  });

  it('proprietário vê o painel com agrupamento por dia/semana/mês', () => {
    renderIn(<SellerDashboard orgId={ORG} role="owner" />);
    expect(mocks.summaryCalls).toBeGreaterThan(0);
    const group = screen.getByRole('radiogroup', { name: 'Agrupar vendas' });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Por dia', 'Por semana', 'Por mês']);
    expect(screen.getByText('Vendas por canal')).toBeInTheDocument();
  });
});
