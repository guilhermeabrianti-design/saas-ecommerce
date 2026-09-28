import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { Bell, PackageX } from 'lucide-react';
import {
  OrganizationContext,
  type OrganizationContextValue,
} from '@/features/organizations/organization-context';
import { NotificationsPage } from './pages/NotificationsPage';
import {
  badgeText,
  kindStyle,
  notificationSchema,
  relativeTime,
  safeLink,
  type Notification,
} from './notifications';

const mocks = vi.hoisted(() => ({
  list: [] as unknown[],
  markRead: vi.fn(),
  markAll: vi.fn(),
}));

vi.mock('./api', () => ({
  NOTIFICATIONS_PAGE_SIZE: 30,
  useNotifications: () => ({ isPending: false, isError: false, data: mocks.list }),
  useMarkRead: () => ({ mutate: mocks.markRead, isPending: false }),
  useMarkAllRead: () => ({ mutate: mocks.markAll, isPending: false }),
}));

const note = (over: Partial<Notification>): Notification => ({
  id: '5b7c2a53-6d4e-4c1b-9f53-0b3f6f0f7a11',
  organization_id: null,
  kind: 'stock.out',
  title: 'Esgotado: Camiseta',
  body: 'Disponível agora: 0.',
  link: '/estoque/abc',
  read_at: null,
  created_at: new Date().toISOString(),
  organizations: null,
  ...over,
});

describe('apresentação', () => {
  it('tempo relativo, selo e tipo', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    expect(relativeTime('2026-09-28T11:59:40Z', now)).toBe('agora');
    expect(relativeTime('2026-09-28T11:55:00Z', now)).toBe('há 5 min');
    expect(relativeTime('2026-09-28T09:00:00Z', now)).toBe('há 3 h');
    expect(relativeTime('2026-09-27T09:00:00Z', now)).toBe('ontem');
    expect(relativeTime('2026-09-20T09:00:00Z', now)).toBe('20/09/2026');
    expect(badgeText(7)).toBe('7');
    expect(badgeText(150)).toBe('99+');
    expect(kindStyle('stock.out')).toEqual({ icon: PackageX, tone: 'danger' });
    expect(kindStyle('algo.novo')).toEqual({ icon: Bell, tone: 'info' });
  });

  it('só navega para caminhos internos', () => {
    expect(safeLink('/pedidos/123')).toBe('/pedidos/123');
    expect(safeLink('https://evil.example')).toBeNull();
    expect(safeLink('//localhost')).toBeNull();
    expect(safeLink('/x?y=<script>')).toBeNull();
    expect(safeLink(null)).toBeNull();
  });

  it('valida o formato vindo da API', () => {
    expect(notificationSchema.safeParse(note({})).success).toBe(true);
    expect(notificationSchema.safeParse({ ...note({}), id: 'x' }).success).toBe(false);
  });
});

describe('página', () => {
  const value: OrganizationContextValue = {
    memberships: [
      {
        role: 'owner',
        organization: {
          id: '99999999-2222-4333-8444-555555555555',
          name: 'Loja V',
          kind: 'seller',
        },
      },
      {
        role: 'member',
        organization: {
          id: '99999999-2222-4333-8444-666666666666',
          name: 'Loja W',
          kind: 'seller',
        },
      },
    ],
    isPending: false,
    isError: false,
    active: null,
    selectOrganization: () => {},
  };

  const renderPage = () =>
    render(
      <MemoryRouter>
        <OrganizationContext value={value}>
          <NotificationsPage />
        </OrganizationContext>
      </MemoryRouter>,
    );

  it('lista, mostra a organização e marca como lida ao abrir', async () => {
    mocks.list = [
      note({ organizations: { name: 'Loja W' } }),
      note({
        id: '7c9d3b64-7e5f-4d2c-8a64-1c4a7a1a8b22',
        kind: 'checkout.paid',
        title: 'Venda paga',
        link: null,
        read_at: '2026-09-28T10:00:00Z',
      }),
    ];
    renderPage();
    expect(screen.getByText(/Loja W/)).toBeInTheDocument();
    expect(screen.getAllByLabelText('Não lida')).toHaveLength(1);

    await userEvent.click(screen.getByRole('link', { name: /Esgotado: Camiseta/ }));
    expect(mocks.markRead).toHaveBeenCalledWith(['5b7c2a53-6d4e-4c1b-9f53-0b3f6f0f7a11']);

    // Já lida: não marca de novo.
    mocks.markRead.mockClear();
    await userEvent.click(screen.getByRole('button', { name: /Venda paga/ }));
    expect(mocks.markRead).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Marcar todas como lidas' }));
    expect(mocks.markAll).toHaveBeenCalled();
  });

  it('vazio', () => {
    mocks.list = [];
    renderPage();
    expect(screen.getByText('Nenhuma notificação ainda.')).toBeInTheDocument();
  });
});
