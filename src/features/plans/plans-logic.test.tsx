import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Membership } from '@/features/organizations/api';
import {
  OrganizationContext,
  type OrganizationContextValue,
} from '@/features/organizations/organization-context';
import { PlanPage } from './pages/PlanPage';
import {
  formatPlanPrice,
  planDraftToInput,
  planFeatures,
  plansErrorMessage,
  subscriptionNote,
  toPlanDraft,
  type BillingOverview,
} from './plans';

const mocks = vi.hoisted(() => ({ overview: null as unknown }));

vi.mock('./api', () => ({
  useBillingOverview: () => ({ isPending: false, isError: false, data: mocks.overview }),
  useSubscribe: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useCancelSubscription: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useRefreshSubscription: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

const free = {
  id: '11111111-2222-4333-8444-555555555555',
  name: 'Grátis',
  description: null,
  price_cents: 0,
  ai_daily_limit: null,
  max_products: null,
  featured_slots: 0,
  is_default: true,
};
const pro = {
  ...free,
  id: '22222222-2222-4333-8444-555555555555',
  name: 'Pro',
  price_cents: 4990,
  ai_daily_limit: 200,
  max_products: 500,
  featured_slots: 3,
  is_default: false,
};

const overview: BillingOverview = {
  plan: free,
  usage: { products: 12, ai_today: 3, ai_daily_limit: 50, featured: 0 },
  can_manage: true,
  current: null,
  pending: null,
  plans: [free, pro],
  payments: [],
};

function renderPage(role: Membership['role'], kind: 'seller' | 'supplier') {
  const membership: Membership = {
    role,
    organization: { id: '99999999-2222-4333-8444-555555555555', name: 'Loja V', kind },
  };
  const value: OrganizationContextValue = {
    memberships: [membership],
    isPending: false,
    isError: false,
    active: membership,
    selectOrganization: () => {},
  };
  return render(
    <MemoryRouter>
      <OrganizationContext value={value}>
        <PlanPage />
      </OrganizationContext>
    </MemoryRouter>,
  );
}

describe('regras de exibição', () => {
  it('preço, recursos e situação da assinatura', () => {
    expect(formatPlanPrice(0)).toBe('Grátis');
    expect(formatPlanPrice(4990)).toMatch(/R\$\s?49,90\/mês/);
    expect(planFeatures(pro, 'supplier')).toEqual([
      'Até 500 produtos',
      '200 gerações de IA por dia',
      '3 produtos em destaque no catálogo',
    ]);
    expect(planFeatures(free, 'seller')).toEqual([
      'Produtos sem limite',
      'Gerações de IA no limite padrão',
    ]);
    const base = {
      id: pro.id,
      plan_name: 'Pro',
      price_cents: 4990,
      authorized_at: null,
      next_payment_at: null,
      access_until: '2026-11-02T12:00:00Z',
    };
    expect(
      subscriptionNote({ ...base, status: 'cancelled' }, Date.parse('2026-10-02T00:00:00Z')),
    ).toBe('Cancelada: o plano vale até 02/11/2026.');
    expect(
      subscriptionNote({ ...base, status: 'cancelled' }, Date.parse('2026-12-01T00:00:00Z')),
    ).toBe('Cancelada');
    expect(plansErrorMessage({ message: 'plans.featured_limit' })).toMatch(/vagas de destaque/);
    expect(plansErrorMessage({ message: 'x' })).toMatch(/Tente de novo/);
  });

  it('formulário da equipe', () => {
    const draft = { ...toPlanDraft(null), name: 'Pro', price: '49,90', ai: '200' };
    expect(planDraftToInput(draft, null, false)).toMatchObject({
      org_kind: 'seller',
      price_cents: 4990,
      ai_daily_limit: 200,
      max_products: null,
      featured_slots: 0,
    });
    expect(planDraftToInput({ ...draft, price: '0,50' }, null, false)).toBeNull();
    expect(planDraftToInput({ ...draft, maxProducts: '0' }, null, false)).toBeNull();
    // O gratuito padrão ignora preço e fica sempre ativo.
    expect(planDraftToInput({ ...draft, price: '', active: false }, free.id, true)).toMatchObject({
      price_cents: 0,
      active: true,
    });
  });
});

describe('página Plano', () => {
  it('proprietário vê uso, planos e o botão de assinar', () => {
    mocks.overview = overview;
    renderPage('owner', 'supplier');
    expect(screen.getByText('Plano atual', { selector: 'p.text-brand' })).toBeInTheDocument();
    expect(screen.getByText('Destaques no catálogo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assinar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancelar assinatura' })).toBeNull();
  });

  it('membro não assina; assinatura ativa mostra cancelamento ao proprietário', () => {
    mocks.overview = { ...overview, can_manage: false };
    const { unmount } = renderPage('member', 'seller');
    expect(screen.queryByRole('button', { name: 'Assinar' })).toBeNull();
    expect(screen.getByText('Só o proprietário da empresa muda o plano.')).toBeInTheDocument();
    expect(screen.queryByText('Destaques no catálogo')).toBeNull();
    unmount();

    mocks.overview = {
      ...overview,
      plan: pro,
      current: {
        id: pro.id,
        plan_name: 'Pro',
        status: 'authorized',
        price_cents: 4990,
        next_payment_at: '2026-11-02T12:00:00Z',
        access_until: null,
        authorized_at: '2026-10-02T12:00:00Z',
      },
    };
    renderPage('owner', 'seller');
    expect(screen.getByText(/Próxima cobrança em 02\/11\/2026/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancelar assinatura' })).toBeInTheDocument();
  });
});
