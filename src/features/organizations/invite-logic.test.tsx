import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import {
  clearInviteToken,
  inviteErrorMessage,
  inviteUrl,
  isInviteToken,
  pendingInviteToken,
  rememberInviteToken,
} from './invite';
import { InvitePage } from './pages/InvitePage';

const TOKEN = 'a'.repeat(64);

const state = vi.hoisted(() => ({
  status: 'unauthenticated' as string,
  preview: { isPending: false, isError: false, data: null as unknown },
}));

vi.mock('@/features/auth/auth-context', () => ({ useAuth: () => ({ status: state.status }) }));
vi.mock('./organization-context', () => ({
  useOrganization: () => ({ selectOrganization: vi.fn() }),
}));
vi.mock('./api', () => ({
  useInvitePreview: () => state.preview,
  useAcceptInviteLink: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

function renderPage() {
  const router = createMemoryRouter([{ path: '/convite/:token', element: <InvitePage /> }], {
    initialEntries: [`/convite/${TOKEN}`],
  });
  render(<RouterProvider router={router} />);
}

beforeEach(() => clearInviteToken());

describe('link de convite', () => {
  it('token de 64 hex; link; guarda por 7 dias e limpa', () => {
    expect(isInviteToken(TOKEN)).toBe(true);
    expect(isInviteToken('abc')).toBe(false);
    expect(isInviteToken(`${'a'.repeat(63)}g`)).toBe(false);
    expect(inviteUrl('https://app.thesigns.com', TOKEN)).toBe(
      `https://app.thesigns.com/convite/${TOKEN}`,
    );
    rememberInviteToken(TOKEN, 0);
    expect(pendingInviteToken(6 * 86_400_000)).toBe(TOKEN);
    expect(pendingInviteToken(8 * 86_400_000)).toBeNull();
    clearInviteToken();
    expect(pendingInviteToken()).toBeNull();
    rememberInviteToken('não-é-token');
    expect(pendingInviteToken()).toBeNull();
  });

  it('mensagens claras', () => {
    expect(inviteErrorMessage({ message: 'org.already_in_company' })).toMatch(/outro e-mail/);
    expect(inviteErrorMessage({ message: 'org.invitation_not_found' })).toMatch(/não vale mais/);
  });

  it('sem conta: mostra a empresa e leva para criar a conta já com o convite', async () => {
    state.status = 'unauthenticated';
    state.preview = {
      isPending: false,
      isError: false,
      data: { organization_name: 'Loja Real', kind: 'seller', role: 'admin', expires_at: '' },
    };
    renderPage();
    expect(await screen.findByText('Convite para Loja Real')).toBeInTheDocument();
    expect(screen.getByText('Administrador')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Criar minha conta' })).toHaveAttribute(
      'href',
      `/cadastro?convite=${TOKEN}`,
    );
    expect(pendingInviteToken()).toBe(TOKEN);
  });

  it('com conta: entra na equipe; link vencido avisa e é esquecido', async () => {
    state.status = 'authenticated';
    renderPage();
    expect(await screen.findByRole('button', { name: 'Entrar na equipe' })).toBeInTheDocument();

    state.preview = { isPending: false, isError: false, data: null };
    rememberInviteToken(TOKEN);
    renderPage();
    expect(await screen.findByText(/não vale mais/)).toBeInTheDocument();
    expect(pendingInviteToken()).toBeNull();
  });
});
