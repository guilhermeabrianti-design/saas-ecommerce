import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { AuthContext, type AuthStatus } from './auth-context';
import { RedirectIfAuthenticated, RequireAuth, RequireRole } from './guards';
import { useProfile } from './profile';

vi.mock('./profile', () => ({ useProfile: vi.fn() }));

const routes: RouteObject[] = [
  {
    element: <RedirectIfAuthenticated />,
    children: [{ path: '/entrar', element: <p>tela de login</p> }],
  },
  {
    element: <RequireAuth />,
    children: [
      { path: '/', element: <p>início</p> },
      { path: '/conta', element: <p>minha conta</p> },
      {
        element: <RequireRole allowed={['admin']} />,
        children: [{ path: '/admin', element: <p>painel admin</p> }],
      },
    ],
  },
];

function renderAt(path: string, status: AuthStatus) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthContext.Provider value={{ status, session: null, user: null, signOut: vi.fn() }}>
        <RouterProvider router={router} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return router;
}

function mockRole(role: string) {
  vi.mocked(useProfile).mockReturnValue({
    isPending: false,
    isError: false,
    data: { role },
  } as unknown as ReturnType<typeof useProfile>);
}

describe('RequireAuth', () => {
  it('manda visitante anônimo para o login guardando o destino', async () => {
    const router = renderAt('/conta?aba=senha', 'unauthenticated');
    expect(await screen.findByText('tela de login')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/entrar');
    expect(router.state.location.search).toBe('?next=%2Fconta%3Faba%3Dsenha');
  });

  it('mostra carregamento enquanto a sessão é restaurada', () => {
    renderAt('/conta', 'loading');
    expect(screen.getByRole('status')).toHaveTextContent('Carregando');
  });

  it('libera a rota para usuário autenticado', async () => {
    renderAt('/conta', 'authenticated');
    expect(await screen.findByText('minha conta')).toBeInTheDocument();
  });
});

describe('RedirectIfAuthenticated', () => {
  it('leva o usuário autenticado ao destino seguro em ?next', async () => {
    const router = renderAt('/entrar?next=%2Fconta', 'authenticated');
    expect(await screen.findByText('minha conta')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/conta');
  });

  it('ignora ?next externo (open redirect)', async () => {
    const router = renderAt('/entrar?next=%2F%2Fevil.com', 'authenticated');
    expect(await screen.findByText('início')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });

  it('explica quando a autenticação não está configurada', () => {
    renderAt('/entrar', 'unconfigured');
    expect(screen.getByText('Autenticação não configurada')).toBeInTheDocument();
  });
});

describe('RequireRole', () => {
  it('nega acesso a quem não tem o papel', async () => {
    mockRole('seller');
    renderAt('/admin', 'authenticated');
    expect(await screen.findByRole('heading', { name: 'Acesso negado' })).toBeInTheDocument();
    expect(screen.queryByText('painel admin')).not.toBeInTheDocument();
  });

  it('libera quem tem o papel', async () => {
    mockRole('admin');
    renderAt('/admin', 'authenticated');
    expect(await screen.findByText('painel admin')).toBeInTheDocument();
  });
});
