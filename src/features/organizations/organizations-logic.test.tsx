import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { Membership } from './api';

// O guard consulta as suspensões via React Query; aqui basta controlar o resultado.
const suspendedState = vi.hoisted(() => ({
  value: { isPending: false, data: [] as { id: string; name: string }[] },
}));
vi.mock('./components/EnsureOrganization', () => ({
  EnsureOrganization: () => <p>criando</p>,
}));

vi.mock('@/features/admin/api', () => ({
  useMySuspendedOrganizations: () => suspendedState.value,
}));
import { orgErrorMessage } from './errors';
import { RequireOrganization } from './guards';
import {
  OrganizationContext,
  resolveActiveMembership,
  type OrganizationContextValue,
} from './organization-context';
import { orgPermissions } from './roles';

const loja = (id: string, role: Membership['role'] = 'owner'): Membership => ({
  role,
  organization: { id, name: `Loja ${id}`, kind: 'seller' },
});

describe('resolveActiveMembership', () => {
  const list = [loja('a'), loja('b', 'member')];

  it('usa a escolha salva quando o usuário ainda é membro', () => {
    expect(resolveActiveMembership(list, 'b')?.organization.id).toBe('b');
  });

  it('ignora id salvo de organização da qual o usuário não é membro', () => {
    expect(resolveActiveMembership(list, 'outra')?.organization.id).toBe('a');
  });

  it('retorna null sem organizações', () => {
    expect(resolveActiveMembership([], 'a')).toBeNull();
  });
});

describe('orgPermissions', () => {
  it('só owner/admin convidam, e só owner convida admin', () => {
    expect(orgPermissions.invitableRoles('owner')).toEqual(['member', 'admin']);
    expect(orgPermissions.invitableRoles('admin')).toEqual(['member']);
    expect(orgPermissions.invitableRoles('member')).toEqual([]);
  });

  it('admin remove só membros comuns', () => {
    expect(orgPermissions.removeMember('admin', 'member')).toBe(true);
    expect(orgPermissions.removeMember('admin', 'admin')).toBe(false);
    expect(orgPermissions.removeMember('member', 'member')).toBe(false);
    expect(orgPermissions.removeMember('owner', 'owner')).toBe(true);
  });
});

describe('orgErrorMessage', () => {
  it('traduz erros de regra de negócio do banco', () => {
    expect(orgErrorMessage({ message: 'org.last_owner', code: 'P0001' })).toMatch(
      /ao menos um proprietário/,
    );
  });

  it('não exibe mensagens desconhecidas do servidor', () => {
    expect(orgErrorMessage({ message: 'relation "x" does not exist' })).toBe(
      'Não foi possível concluir a operação. Tente novamente.',
    );
  });
});

describe('RequireOrganization', () => {
  function renderWith(value: Partial<OrganizationContextValue>) {
    const ctx: OrganizationContextValue = {
      memberships: [],
      isPending: false,
      isError: false,
      active: null,
      selectOrganization: vi.fn(),
      ...value,
    };
    const router = createMemoryRouter(
      [
        {
          element: <RequireOrganization />,
          children: [{ path: '/organizacao', element: <p>configurações</p> }],
        },
        { path: '/organizacao/nova', element: <p>criar organização</p> },
      ],
      { initialEntries: ['/organizacao'] },
    );
    render(
      <OrganizationContext.Provider value={ctx}>
        <RouterProvider router={router} />
      </OrganizationContext.Provider>,
    );
  }

  beforeEach(() => {
    suspendedState.value = { isPending: false, data: [] };
  });

  it('não manda para o onboarding quem perdeu a organização por suspensão', async () => {
    suspendedState.value = { isPending: false, data: [{ id: 'x', name: 'Loja X' }] };
    renderWith({});
    await Promise.resolve();
    expect(screen.queryByText('criar organização')).not.toBeInTheDocument();
    expect(screen.queryByText('configurações')).not.toBeInTheDocument();
  });

  it('quem não tem organização ganha a sua na hora (sem formulário)', async () => {
    renderWith({});
    expect(await screen.findByText('criando')).toBeInTheDocument();
    expect(screen.queryByText('criar organização')).not.toBeInTheDocument();
  });

  it('libera a área com organização ativa', async () => {
    renderWith({ memberships: [loja('a')], active: loja('a') });
    expect(await screen.findByText('configurações')).toBeInTheDocument();
  });

  it('mostra carregamento enquanto as organizações carregam', () => {
    renderWith({ isPending: true });
    expect(screen.getByRole('status')).toHaveTextContent('Carregando');
  });
});
