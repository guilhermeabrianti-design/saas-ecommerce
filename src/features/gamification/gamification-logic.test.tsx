import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Membership } from '@/features/organizations/api';
import {
  OrganizationContext,
  type OrganizationContextValue,
} from '@/features/organizations/organization-context';
import {
  formatPoints,
  gamificationErrorMessage,
  levelProgress,
  monthLabel,
  validateLevels,
  type GamificationSummary,
  type Ranking,
} from './gamification';
import { AchievementsPage } from './pages/AchievementsPage';

const mocks = vi.hoisted(() => ({ summary: null as unknown, ranking: null as unknown }));

vi.mock('./api', () => ({
  useGamificationSummary: () => ({ isPending: false, isError: false, data: mocks.summary }),
  useRanking: () => ({ isPending: false, isError: false, data: mocks.ranking }),
  useSetRankingVisibility: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

function withOrg(role: Membership['role'], kind: 'seller' | 'supplier') {
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
        <AchievementsPage />
      </OrganizationContext>
    </MemoryRouter>,
  );
}

const summary: GamificationSummary = {
  total: 150,
  month: 40,
  level: { name: 'Bronze', min_points: 100 },
  next_level: { name: 'Prata', min_points: 500 },
  show_in_ranking: false,
  rules: [{ event: 'sale_delivered', label: 'Venda entregue', points: 10, daily_cap: 200 }],
  achievements: [
    {
      code: 'first_sale',
      name: 'Primeira venda',
      description: 'Entregou a primeira venda.',
      threshold: 1,
      progress: 1,
      earned_at: '2026-10-02T12:00:00Z',
    },
    {
      code: 'sales_10',
      name: '10 vendas',
      description: 'Entregou 10 vendas.',
      threshold: 10,
      progress: 4,
      earned_at: null,
    },
  ],
  recent: [
    {
      event: 'sale_delivered',
      label: 'Venda entregue',
      points: 10,
      created_at: '2026-10-02T12:00:00Z',
    },
    {
      event: 'sale_delivered',
      label: 'Venda entregue',
      points: -10,
      created_at: '2026-10-02T13:00:00Z',
    },
  ],
};

const ranking: Ranking = {
  month: '2026-10',
  top: [
    { position: 1, name: 'Loja anônima', points: 90, is_me: false },
    { position: 2, name: 'Loja V', points: 40, is_me: true },
  ],
  me: { position: 2, points: 40 },
};

describe('regras da tela', () => {
  it('progresso do nível, pontos e mês', () => {
    expect(levelProgress(summary)).toBeCloseTo(12.5);
    expect(levelProgress({ ...summary, next_level: null })).toBe(100);
    expect(
      levelProgress({ total: 0, level: null, next_level: { name: 'X', min_points: 10 } }),
    ).toBe(0);
    expect(formatPoints(10)).toBe('+10 pontos');
    expect(formatPoints(-1)).toBe('-1 ponto');
    expect(monthLabel('2026-10')).toBe('outubro de 2026');
  });

  it('níveis: nome, mínimos diferentes, um em zero; ordena', () => {
    expect(validateLevels([]).error).toBeTruthy();
    expect(validateLevels([{ name: 'A', min_points: '0' }]).error).toMatch(/nome/);
    expect(validateLevels([{ name: 'Novo', min_points: '-1' }]).error).toMatch(/inteiro/);
    expect(
      validateLevels([
        { name: 'Novo', min_points: '0' },
        { name: 'Outro', min_points: '0' },
      ]).error,
    ).toMatch(/mesmo mínimo/);
    expect(validateLevels([{ name: 'Novo', min_points: '5' }]).error).toMatch(/começa em 0/);
    expect(
      validateLevels([
        { name: 'Pro', min_points: '50' },
        { name: ' Novo ', min_points: '0' },
      ]).values,
    ).toEqual([
      { name: 'Novo', min_points: 0 },
      { name: 'Pro', min_points: 50 },
    ]);
    expect(gamificationErrorMessage({ message: 'admin.forbidden' })).toMatch(/equipe/);
    expect(gamificationErrorMessage(null)).toMatch(/Tente de novo/);
  });
});

describe('tela Conquistas', () => {
  it('nível, conquistas, ranking e escolha de aparecer (só proprietário do vendedor)', () => {
    mocks.summary = summary;
    mocks.ranking = ranking;
    const { unmount } = withOrg('owner', 'seller');
    expect(screen.getByText('Bronze')).toBeInTheDocument();
    expect(screen.getByText('Faltam 350 pontos para Prata.')).toBeInTheDocument();
    expect(screen.getByText(/Conquistada em/)).toBeInTheDocument();
    expect(screen.getByText('4 de 10')).toBeInTheDocument();
    expect(screen.getByText('Loja V (você)')).toBeInTheDocument();
    expect(screen.getByText('Ranking de outubro de 2026')).toBeInTheDocument();
    expect(screen.getByText('Venda entregue (estorno)')).toBeInTheDocument();
    expect(screen.getByLabelText('Mostrar o nome da minha loja no ranking')).not.toBeChecked();
    unmount();

    const member = withOrg('member', 'seller');
    expect(screen.queryByLabelText('Mostrar o nome da minha loja no ranking')).toBeNull();
    member.unmount();

    withOrg('owner', 'supplier');
    expect(screen.queryByLabelText('Mostrar o nome da minha loja no ranking')).toBeNull();
    expect(screen.getByText(/entre fornecedores/)).toBeInTheDocument();
  });
});
