import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Membership } from '@/features/organizations/api';
import {
  OrganizationContext,
  type OrganizationContextValue,
} from '@/features/organizations/organization-context';
import { SponsorshipsPage } from './pages/SponsorshipsPage';
import {
  campaignState,
  packageDraftToInput,
  sponsorshipErrorMessage,
  toPackageDraft,
  type SponsorshipOverview,
} from './sponsorships';

const mocks = vi.hoisted(() => ({ overview: null as unknown }));

vi.mock('./api', () => ({
  useSponsorshipOverview: () => ({ isPending: false, isError: false, data: mocks.overview }),
  useBuySponsorship: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useSponsorshipReturn: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

const listingId = '11111111-2222-4333-8444-555555555555';
const overview: SponsorshipOverview = {
  can_manage: true,
  packages: [
    {
      id: '22222222-2222-4333-8444-555555555555',
      placement: 'catalog',
      name: 'Topo do catálogo',
      duration_days: 7,
      price_cents: 2990,
      sold_out: false,
    },
    {
      id: '33333333-2222-4333-8444-555555555555',
      placement: 'sales_center',
      name: 'Central',
      duration_days: 1,
      price_cents: 990,
      sold_out: true,
    },
  ],
  listings: [{ id: listingId, name: 'Smartwatch D20' }],
  campaigns: [
    {
      id: '44444444-2222-4333-8444-555555555555',
      listing_id: listingId,
      listing_name: 'Smartwatch D20',
      placement: 'catalog',
      package_name: 'Topo do catálogo',
      duration_days: 7,
      price_cents: 2990,
      status: 'active',
      checkout_url: null,
      starts_at: '2026-10-01T12:00:00Z',
      ends_at: '2026-10-08T12:00:00Z',
      created_at: '2026-10-01T11:00:00Z',
      live: true,
      views: 4,
      imports: 1,
    },
  ],
};

function renderPage(role: Membership['role']) {
  const membership: Membership = {
    role,
    organization: { id: '99999999-2222-4333-8444-555555555555', name: 'Fábrica', kind: 'supplier' },
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
        <SponsorshipsPage />
      </OrganizationContext>
    </MemoryRouter>,
  );
}

describe('regras', () => {
  it('situação da campanha e mensagens', () => {
    expect(campaignState({ status: 'pending', live: false, starts_at: null, ends_at: null })).toBe(
      'Aguardando pagamento',
    );
    expect(
      campaignState({
        status: 'active',
        live: true,
        starts_at: '2026-10-01T12:00:00Z',
        ends_at: '2026-10-08T12:00:00Z',
      }),
    ).toBe('No ar até 08/10/2026');
    expect(
      campaignState({
        status: 'active',
        live: false,
        starts_at: 'x',
        ends_at: '2026-10-08T12:00:00Z',
      }),
    ).toBe('Encerrada em 08/10/2026');
    expect(sponsorshipErrorMessage({ message: 'sold_out' })).toMatch(/esgotadas/);
  });

  it('formulário da equipe', () => {
    const d = { ...toPackageDraft(null), name: 'Topo', price: '29,90' };
    expect(packageDraftToInput(d, null)).toMatchObject({
      placement: 'catalog',
      duration_days: 7,
      price_cents: 2990,
      max_active: null,
    });
    expect(packageDraftToInput({ ...d, days: '91' }, null)).toBeNull();
    expect(packageDraftToInput({ ...d, price: '0,99' }, null)).toBeNull();
    expect(packageDraftToInput({ ...d, maxActive: '0' }, null)).toBeNull();
  });
});

describe('página Patrocínios', () => {
  it('owner/admin compra; pacote esgotado desabilitado; resultados da campanha', () => {
    mocks.overview = overview;
    renderPage('owner');
    expect(screen.getByRole('button', { name: 'Pagar e colocar no ar' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Central/ })).toBeDisabled();
    expect(screen.getByText('4 lojas abriram')).toBeInTheDocument();
    expect(screen.getByText('1 loja importou')).toBeInTheDocument();
  });

  it('membro só acompanha', () => {
    mocks.overview = { ...overview, can_manage: false };
    renderPage('member');
    expect(screen.queryByRole('button', { name: 'Pagar e colocar no ar' })).toBeNull();
    expect(
      screen.getByText('Só proprietário e administradores compram patrocínio.'),
    ).toBeInTheDocument();
  });
});
