import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { commissionSourceLabels } from '@/features/fees/fees';
import type { Membership } from '@/features/organizations/api';
import {
  OrganizationContext,
  type OrganizationContextValue,
} from '@/features/organizations/organization-context';
import type { Material } from './api';
import { MaterialView } from './components/MaterialView';
import { LiveCampaignPage } from './pages/LiveCampaignPage';
import {
  campaignFormSchema,
  campaignPhase,
  isFileKind,
  materialFormSchema,
  salesAuditLabels,
  salesErrorMessage,
  toCampaignPayload,
  validateMaterialFile,
  type CampaignFormValues,
} from './sales';

const mocks = vi.hoisted(() => ({
  campaign: {
    id: '11111111-2222-4333-8444-555555555555',
    name: 'Live de Canecas',
    description: 'Sexta às 20h',
    provider: 'tiktok',
    starts_at: '2026-09-26T23:00:00Z',
    ends_at: '2026-09-27T02:00:00Z',
    commission_bps: 2500,
    joined: false,
    listings: [],
  },
}));

vi.mock('./api', () => ({
  useLiveCampaign: () => ({ isPending: false, isError: false, data: mocks.campaign }),
  useSetParticipation: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

describe('materiais', () => {
  it('arquivo x texto e validação do formulário', () => {
    expect(isFileKind('video')).toBe(true);
    expect(isFileKind('hashtags')).toBe(false);
    expect(
      materialFormSchema.safeParse({ kind: 'script', title: 'Roteiro', body: '  ' }).error
        ?.issues[0]?.path,
    ).toEqual(['body']);
    expect(materialFormSchema.safeParse({ kind: 'video', title: 'Demo', body: '' }).success).toBe(
      true,
    );
  });

  it('pré-checagem do arquivo por tipo e tamanho', () => {
    const file = (type: string, size = 10) =>
      new File([new Uint8Array(size)], 'x', { type }) as File;
    expect(validateMaterialFile(file('video/mp4'), 'video')).toBeNull();
    expect(validateMaterialFile(file('image/png'), 'video')).toMatch(/MP4/);
    expect(validateMaterialFile(file('video/mp4'), 'image')).toMatch(/JPEG/);
    const big = file('image/png');
    Object.defineProperty(big, 'size', { value: 101 * 1024 * 1024 });
    expect(validateMaterialFile(big, 'image')).toMatch(/100 MB/);
  });

  it('texto tem copiar; arquivo tem baixar com o nome do arquivo', () => {
    const text: Material = {
      id: '1',
      kind: 'hashtags',
      title: 'Hashtags',
      body: '#caneca',
      storage_path: null,
      file: null,
    };
    const { unmount } = render(<MaterialView material={text} />);
    expect(screen.getByRole('button', { name: 'Copiar Hashtags' })).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
    unmount();

    const video: Material = {
      id: '2',
      kind: 'video',
      title: 'Demo',
      body: null,
      storage_path: 'l/u/demo.mp4',
      file: { view: 'https://x/v?token=a', download: 'https://x/v?token=a&download=demo.mp4' },
    };
    render(<MaterialView material={video} />);
    expect(screen.getByRole('link', { name: 'Baixar Demo' })).toHaveAttribute(
      'href',
      'https://x/v?token=a&download=demo.mp4',
    );
    expect(screen.queryByRole('button', { name: /Copiar/ })).toBeNull();
  });
});

describe('campanhas', () => {
  const valid: CampaignFormValues = {
    name: 'Live de Canecas',
    description: '',
    provider: 'tiktok',
    startsAt: '2026-09-26T20:00',
    endsAt: '2026-09-26T23:00',
    commission: '22,5',
    status: 'published',
    listingIds: ['11111111-2222-4333-8444-555555555555'],
  };

  it('regras do formulário', () => {
    expect(campaignFormSchema.safeParse(valid).success).toBe(true);
    const issue = (v: Partial<CampaignFormValues>) =>
      campaignFormSchema.safeParse({ ...valid, ...v }).error?.issues[0]?.path[0];
    expect(issue({ endsAt: '2026-09-26T19:00' })).toBe('endsAt');
    expect(issue({ endsAt: '2027-01-26T19:00' })).toBe('endsAt');
    expect(issue({ listingIds: [] })).toBe('listingIds');
    expect(issue({ commission: '101' })).toBe('commission');
    expect(issue({ commission: 'abc' })).toBe('commission');
    // Rascunho pode ficar sem produtos.
    expect(
      campaignFormSchema.safeParse({ ...valid, status: 'draft', listingIds: [] }).success,
    ).toBe(true);
  });

  it('payload: comissão em pontos-base, vazio segue as regras', () => {
    const p = toCampaignPayload(valid);
    expect(p.commission_bps).toBe(2250);
    expect(p.provider).toBe('tiktok');
    expect(p.starts_at).toBe(new Date('2026-09-26T20:00').toISOString());
    expect(toCampaignPayload({ ...valid, commission: '', provider: '' })).toMatchObject({
      commission_bps: null,
      provider: null,
    });
  });

  it('fase pelo horário', () => {
    const s = '2026-09-26T20:00:00Z';
    const e = '2026-09-26T23:00:00Z';
    expect(campaignPhase(s, e, Date.parse('2026-09-26T19:00:00Z'))).toBe('upcoming');
    expect(campaignPhase(s, e, Date.parse('2026-09-26T20:00:00Z'))).toBe('live');
    expect(campaignPhase(s, e, Date.parse('2026-09-26T23:00:00Z'))).toBe('ended');
  });

  it('erros, auditoria e origem da comissão traduzidos', () => {
    for (const code of [
      'sales.too_many_materials',
      'campaign.invalid',
      'campaign.not_found',
      'campaign.ended',
      'campaign.listing_not_found',
      'campaign.no_listings',
    ]) {
      expect(salesErrorMessage({ message: code })).not.toMatch(/^(sales|campaign)\./);
    }
    expect(salesErrorMessage({ message: 'new row violates row-level security policy' })).toMatch(
      /permissão/,
    );
    expect(Object.keys(salesAuditLabels)).toEqual([
      'live_campaign.created',
      'live_campaign.updated',
    ]);
    expect(commissionSourceLabels.live_campaign).toBe('campanha de live');
  });

  function renderCampaign(role: Membership['role']) {
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
      <OrganizationContext value={value}>
        <MemoryRouter initialEntries={[`/central/lives/${mocks.campaign.id}`]}>
          <Routes>
            <Route path="/central/lives/:campaignId" element={<LiveCampaignPage />} />
          </Routes>
        </MemoryRouter>
      </OrganizationContext>,
    );
  }

  it('proprietário inscreve a loja; membro não', () => {
    const { unmount } = renderCampaign('owner');
    expect(screen.getByRole('button', { name: 'Participar' })).toBeInTheDocument();
    expect(screen.getByText(/passa a 25%/)).toBeInTheDocument();
    unmount();

    renderCampaign('member');
    expect(screen.queryByRole('button', { name: 'Participar' })).toBeNull();
    expect(screen.getByText(/Proprietários e administradores inscrevem/)).toBeInTheDocument();
  });
});
