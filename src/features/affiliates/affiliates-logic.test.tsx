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
  currentAttribution,
  describeProgram,
  isValidCode,
  pendingReferralCode,
  referralUrl,
  rememberAttribution,
  rememberReferralCode,
  targetPath,
  validateReferralSettings,
  visitorId,
  type ReferralSummary,
} from './affiliates';
import { ReferralsPage } from './pages/ReferralsPage';

const mocks = vi.hoisted(() => ({ summary: null as unknown }));

vi.mock('./api', () => ({
  useSetPublicCode: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useReferralSummary: () => ({ isPending: false, isError: false, data: mocks.summary }),
  useApplyReferralCode: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

vi.mock('./components/QrCode', () => ({ QrCode: () => null }));

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  window.localStorage.clear();
});

describe('códigos e endereços', () => {
  it('valida como o banco e monta os links', () => {
    expect(isValidCode(' Loja-V ')).toBe(true);
    expect(isValidCode('abc')).toBe(false);
    expect(isValidCode('a--bc')).toBe(false);
    expect(referralUrl('https://x.app', 'loja-v')).toBe('https://x.app/cadastro?indicacao=loja-v');
    const product = '5b7c2a53-6d4e-4c1b-9f53-0b3f6f0f7a11';
    expect(targetPath({ link_code: 'bio', store_code: 'loja-v', product_id: product })).toBe(
      `/c/${product}`,
    );
    expect(targetPath({ link_code: 'bio', store_code: 'loja-v', product_id: null })).toBe(
      '/loja/loja-v',
    );
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
    // Só o proprietário personaliza o código.
    expect(screen.getByRole('button', { name: 'Salvar código' })).toBeInTheDocument();
    unmount();
    const admin = withOrg('admin', <ReferralsPage />);
    expect(screen.queryByRole('button', { name: 'Salvar código' })).toBeNull();
    admin.unmount();

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
