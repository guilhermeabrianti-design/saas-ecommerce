import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import {
  OrganizationContext,
  type OrganizationContextValue,
} from '@/features/organizations/organization-context';
import type { Membership } from '@/features/organizations/api';
import { createOrganizationFormSchema } from '@/features/organizations/schemas';
import { orgErrorMessage } from '@/features/organizations/errors';
import { ledgerKindLabels } from '@/features/finance/schemas';
import { formatBRL } from '@/utils/money';
import {
  ATTRIBUTION_DAYS,
  affiliateErrorMessage,
  clearReferralCode,
  conversionRate,
  currentAttribution,
  describeProgram,
  formatRate,
  isValidCode,
  linkFormSchema,
  linkUrl,
  pendingReferralCode,
  referralUrl,
  rememberAttribution,
  rememberReferralCode,
  statsTotals,
  storeUrl,
  targetPath,
  validateReferralSettings,
  visitorId,
  type ReferralSummary,
  type StatsRow,
} from './affiliates';
import { AffiliatesPage } from './pages/AffiliatesPage';
import { ReferralsPage } from './pages/ReferralsPage';

const mocks = vi.hoisted(() => ({ stats: [] as unknown[], summary: null as unknown }));

vi.mock('./api', () => ({
  usePublicCode: () => ({ isPending: false, isError: false, data: 'loja-v' }),
  useSetPublicCode: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useAffiliateStats: () => ({ isPending: false, isError: false, data: mocks.stats }),
  useCheckoutProducts: () => ({ isPending: false, isError: false, data: [] }),
  useCreateAffiliateLink: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useUpdateAffiliateLink: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useReferralSummary: () => ({ isPending: false, isError: false, data: mocks.summary }),
  useApplyReferralCode: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

vi.mock('./components/QrCode', () => ({ QrCode: () => null }));

const DAY = 24 * 60 * 60 * 1000;

const row = (over: Partial<StatsRow>): StatsRow => ({
  kind: 'link',
  link_id: null,
  code: null,
  name: 'x',
  product_id: null,
  product_name: null,
  is_active: true,
  clicks: 0,
  visits: 0,
  orders: 0,
  paid_orders: 0,
  sales_cents: 0,
  commission_cents: 0,
  ...over,
});

beforeEach(() => {
  window.localStorage.clear();
});

describe('códigos e endereços', () => {
  it('valida como o banco e monta os links', () => {
    expect(isValidCode(' Loja-V ')).toBe(true);
    expect(isValidCode('abc')).toBe(false);
    expect(isValidCode('a--bc')).toBe(false);
    expect(storeUrl('https://x.app', 'loja-v')).toBe('https://x.app/loja/loja-v');
    expect(linkUrl('https://x.app', 'bio')).toBe('https://x.app/r/bio');
    expect(referralUrl('https://x.app', 'loja-v')).toBe('https://x.app/cadastro?indicacao=loja-v');
    const product = '5b7c2a53-6d4e-4c1b-9f53-0b3f6f0f7a11';
    expect(targetPath({ link_code: 'bio', store_code: 'loja-v', product_id: product })).toBe(
      `/c/${product}`,
    );
    expect(targetPath({ link_code: 'bio', store_code: 'loja-v', product_id: null })).toBe(
      '/loja/loja-v',
    );
  });

  it('formulário de link: código opcional', () => {
    expect(linkFormSchema.safeParse({ name: 'Bio', code: '', target: '' }).success).toBe(true);
    expect(linkFormSchema.safeParse({ name: 'Bio', code: 'b!', target: '' }).success).toBe(false);
    expect(linkFormSchema.safeParse({ name: 'B', code: '', target: '' }).success).toBe(false);
  });
});

describe('navegador do comprador', () => {
  it('visitante estável; origem vale por 30 dias', () => {
    const id = visitorId();
    expect(visitorId()).toBe(id);

    const now = Date.now();
    rememberAttribution({ store_code: 'loja-v', link_code: 'bio' }, now);
    expect(currentAttribution(now + DAY)).toEqual({ store_code: 'loja-v', link_code: 'bio' });
    expect(currentAttribution(now + (ATTRIBUTION_DAYS + 1) * DAY)).toBeNull();
    // Expirada é apagada.
    expect(currentAttribution(now)).toBeNull();

    window.localStorage.setItem('thesigns:attribution', '{quebrado');
    expect(currentAttribution()).toBeNull();
  });

  it('código de indicação do link de cadastro', () => {
    rememberReferralCode(' Loja-V ');
    expect(pendingReferralCode()).toBe('loja-v');
    clearReferralCode();
    expect(pendingReferralCode()).toBeNull();
    rememberReferralCode('<x>');
    expect(pendingReferralCode()).toBeNull();
  });
});

describe('desempenho', () => {
  it('conversão = vendas pagas / visitas; acesso direto fica fora da conversão', () => {
    expect(conversionRate(1, 3)).toBe(33.3);
    expect(conversionRate(0, 0)).toBeNull();
    expect(formatRate(33.3)).toBe('33,3%');
    expect(formatRate(null)).toBe('—');

    const totals = statsTotals([
      row({ kind: 'store', clicks: 10, visits: 8, orders: 1, paid_orders: 1, sales_cents: 5990 }),
      row({ kind: 'link', clicks: 5, visits: 2, orders: 2, paid_orders: 1, sales_cents: 5990 }),
      row({ kind: 'direct', clicks: null, visits: null, orders: 3, paid_orders: 3 }),
    ]);
    expect(totals).toMatchObject({ clicks: 15, visits: 10, orders: 6, paid_orders: 5 });
    expect(totals.conversion).toBe(20);
  });
});

describe('regras de indicação (equipe)', () => {
  const base = { enabled: true, reward: '50,00', min_sale: '0', window_days: '90' };

  it('converte e valida', () => {
    expect(validateReferralSettings(base).values).toEqual({
      enabled: true,
      reward_cents: 5000,
      min_sale_cents: 0,
      window_days: 90,
    });
    expect(validateReferralSettings({ ...base, reward: '0' }).errors.reward).toMatch(
      /maior que zero/,
    );
    expect(
      validateReferralSettings({ ...base, enabled: false, reward: '0' }).values,
    ).not.toBeNull();
    expect(
      validateReferralSettings({ ...base, window_days: '0' }).errors.window_days,
    ).toBeDefined();
    expect(validateReferralSettings({ ...base, min_sale: 'abc' }).errors.min_sale).toBeDefined();
  });

  it('descreve a regra e traduz erros', () => {
    expect(
      describeProgram(
        { enabled: true, reward_cents: 5000, min_sale_cents: 10000, window_days: 60 },
        formatBRL,
      ).replace(/\s/g, ' '),
    ).toBe(
      'Você ganha R$ 50,00 quando a empresa indicada fizer a primeira venda paga pelo checkout de pelo menos R$ 100,00 em até 60 dias.',
    );
    expect(affiliateErrorMessage({ message: 'affiliates.code_taken' })).toMatch(/em uso/);
    expect(affiliateErrorMessage({ message: 'referral.self' })).toMatch(/si mesmo/);
    expect(affiliateErrorMessage(new Error('x'))).toMatch(/Tente de novo/);
    expect(orgErrorMessage({ message: 'referral.invalid_code' })).toMatch(/não encontrado/);
    expect(ledgerKindLabels.referral_reward).toBe('Recompensa de indicação');
  });

  it('criação de organização aceita código vazio ou válido', () => {
    expect(
      createOrganizationFormSchema.safeParse({ name: 'Loja', referral_code: '' }).success,
    ).toBe(true);
    expect(
      createOrganizationFormSchema.safeParse({ name: 'Loja', referral_code: 'loja-v' }).success,
    ).toBe(true);
    expect(
      createOrganizationFormSchema.safeParse({ name: 'Loja', referral_code: 'x!' }).success,
    ).toBe(false);
  });
});

function withOrg(role: Membership['role'], ui: React.ReactNode) {
  const membership: Membership = {
    role,
    organization: { id: '99999999-2222-4333-8444-555555555555', name: 'Loja V', kind: 'seller' },
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
      <OrganizationContext value={value}>{ui}</OrganizationContext>
    </MemoryRouter>,
  );
}

describe('telas', () => {
  it('links e divulgação: vitrine, desempenho e só owner troca o endereço', () => {
    mocks.stats = [
      row({ kind: 'store', code: 'loja-v', name: 'Página da loja', clicks: 4, visits: 3 }),
      row({
        kind: 'link',
        link_id: '7c9d3b64-7e5f-4d2c-8a64-1c4a7a1a8b22',
        code: 'bio',
        name: 'Bio do Instagram',
        is_active: false,
        visits: 2,
        orders: 1,
        paid_orders: 1,
        sales_cents: 5990,
        commission_cents: 899,
      }),
      row({ kind: 'direct', name: 'Acesso direto ao produto', clicks: null, visits: null }),
    ];
    const { unmount } = withOrg('owner', <AffiliatesPage />);
    expect(screen.getByLabelText('Link da loja')).toHaveValue(
      `${window.location.origin}/loja/loja-v`,
    );
    expect(screen.getByLabelText('Link Bio do Instagram')).toHaveValue(
      `${window.location.origin}/r/bio`,
    );
    expect(screen.getByText('Pausado')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reativar' })).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Salvar endereço' })).toBeInTheDocument();
    unmount();

    const admin = withOrg('admin', <AffiliatesPage />);
    expect(screen.queryByRole('button', { name: 'Salvar endereço' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Criar link' })).toBeInTheDocument();
    admin.unmount();

    withOrg('member', <AffiliatesPage />);
    expect(screen.getByText(/apenas para proprietários e administradores/)).toBeInTheDocument();
  });

  const summary: ReferralSummary = {
    code: 'loja-v',
    program: { enabled: true, reward_cents: 5000, min_sale_cents: 0, window_days: 90 },
    referred_by: null,
    can_apply: true,
    earned_cents: 5000,
    referrals: [
      {
        name: 'Fábrica X',
        kind: 'supplier',
        created_at: '2026-09-01T12:00:00Z',
        expires_at: '2026-11-30T12:00:00Z',
        reward_cents: 5000,
        min_sale_cents: 0,
        rewarded_at: '2026-09-10T12:00:00Z',
        status: 'rewarded',
      },
    ],
  };

  it('indique e ganhe: link, indicações e código de quem indicou', () => {
    mocks.summary = summary;
    const { unmount } = withOrg('owner', <ReferralsPage />);
    expect(screen.getByLabelText('Link de indicação')).toHaveValue(
      `${window.location.origin}/cadastro?indicacao=loja-v`,
    );
    expect(screen.getByText('Recompensa creditada')).toBeInTheDocument();
    expect(screen.getByText(/Recompensas creditadas até agora: R\$ 50,00/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Informar código' })).toBeInTheDocument();
    unmount();

    mocks.summary = {
      ...summary,
      program: { ...summary.program, enabled: false },
      can_apply: false,
      referred_by: {
        name: 'Loja Mãe',
        created_at: '2026-09-01T12:00:00Z',
        expires_at: '2026-11-30T12:00:00Z',
        rewarded_at: null,
      },
    };
    withOrg('owner', <ReferralsPage />);
    expect(screen.getByText(/programa de indicação está pausado/)).toBeInTheDocument();
    expect(screen.getByText('Loja Mãe')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Informar código' })).toBeNull();
  });
});
