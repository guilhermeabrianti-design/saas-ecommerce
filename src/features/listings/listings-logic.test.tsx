import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import {
  OrganizationContext,
  type OrganizationContextValue,
} from '@/features/organizations/organization-context';
import { ListingPage } from './pages/ListingPage';
import {
  groupRuns,
  listingErrorMessage,
  listingFormSchema,
  type ChannelListing,
  type ListingStep,
} from './listings';

const mocks = vi.hoisted(() => ({
  listing: null as unknown,
  steps: [] as unknown[],
  action: vi.fn(),
}));

vi.mock('./api', () => ({
  useChannelListing: () => ({ isPending: false, isError: false, data: mocks.listing }),
  useListingSteps: () => ({ isPending: false, isError: false, data: mocks.steps }),
  useListingAction: () => ({ mutate: mocks.action, isPending: false, isError: false }),
  useSaveListing: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useDuplicateListing: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useDeleteListing: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  usePublishableConnections: () => ({ isPending: false, data: [] }),
}));

const run = '5b7c2a53-6d4e-4c1b-9f53-0b3f6f0f7a11';
const older = '7c9d3b64-7e5f-4d2c-8a64-1c4a7a1a8b22';
const step = (id: number, over: Partial<ListingStep>): ListingStep => ({
  id,
  run_id: run,
  action: 'publish',
  step: 'validate',
  status: 'ok',
  message: null,
  created_at: '2026-09-28T12:00:00Z',
  ...over,
});

const listing: ChannelListing = {
  id: run,
  connection_id: older,
  product_id: older,
  title: 'Camiseta Azul',
  description: null,
  price_cents: null,
  status: 'publishing',
  run_action: 'publish',
  external_id: null,
  external_url: null,
  last_error: null,
  last_published_at: null,
  updated_at: '2026-09-28T12:00:00Z',
  integration_connections: { name: 'Minha Shopify', provider: 'shopify' },
  products: { name: 'Camiseta', sku: 'FX-CAM' },
};

describe('regras', () => {
  it('agrupa etapas por execução, mais recente primeiro', () => {
    const runs = groupRuns([
      step(4, { step: 'product' }),
      step(3, { step: 'validate' }),
      step(2, { run_id: older, step: 'done', status: 'error' }),
      step(1, { run_id: older, step: 'validate' }),
    ]);
    expect(runs.map((r) => [r.runId, r.finished, r.ok, r.steps.map((s) => s.step)])).toEqual([
      [run, false, true, ['validate', 'product']],
      [older, true, false, ['validate', 'done']],
    ]);
  });

  it('formulário e mensagens', () => {
    expect(
      listingFormSchema.safeParse({ title: 'Camiseta', description: '', price: '' }).success,
    ).toBe(true);
    expect(
      listingFormSchema.safeParse({ title: 'Camiseta', description: '', price: '0' }).success,
    ).toBe(false);
    expect(listingErrorMessage({ message: 'listings.busy' })).toMatch(/andamento/);
    expect(listingErrorMessage({ message: 'Shopify: Title is too long' })).toBe(
      'Shopify: Title is too long',
    );
    expect(listingErrorMessage({ message: 'algum.codigo_novo' })).toMatch(/Tente de novo/);
  });
});

describe('página do anúncio', () => {
  const value: OrganizationContextValue = {
    memberships: [],
    isPending: false,
    isError: false,
    active: {
      role: 'owner',
      organization: { id: '99999999-2222-4333-8444-555555555555', name: 'Loja V', kind: 'seller' },
    },
    selectOrganization: () => {},
  };
  const renderPage = () =>
    render(
      <MemoryRouter initialEntries={[`/anuncios/${run}`]}>
        <OrganizationContext value={value}>
          <Routes>
            <Route path="/anuncios/:listingId" element={<ListingPage />} />
          </Routes>
        </OrganizationContext>
      </MemoryRouter>,
    );

  it('durante o envio mostra as etapas reais e bloqueia novas ações', () => {
    mocks.listing = listing;
    mocks.steps = [
      step(2, { step: 'credentials', message: 'Credenciais carregadas.' }),
      step(1, { message: 'Dados conferidos: 2 variação(ões).' }),
    ];
    renderPage();
    expect(screen.getByText('Enviando…')).toBeInTheDocument();
    expect(screen.getByText('Conferência dos dados')).toBeInTheDocument();
    expect(screen.getByText('Credenciais da loja')).toBeInTheDocument();
    expect(screen.getByText('Aguardando o marketplace…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publicar' })).toBeDisabled();
  });

  it('publicado e pausado: reativar; link do marketplace; erro legível', async () => {
    mocks.listing = {
      ...listing,
      status: 'paused',
      external_id: '555',
      external_url: 'https://loja.com/products/camiseta',
      last_error: '1 SKU(s) já vinculados a outro item nesta conexão: confira em Integrações.',
    };
    mocks.steps = [];
    renderPage();
    expect(screen.getByRole('link', { name: /Ver no marketplace/ })).toHaveAttribute(
      'href',
      'https://loja.com/products/camiseta',
    );
    expect(screen.getByText(/já vinculados a outro item/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apagar rascunho' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Reativar' }));
    expect(mocks.action).toHaveBeenCalledWith('activate');
  });
});
