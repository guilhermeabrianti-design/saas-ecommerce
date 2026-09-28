import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { Session, User } from '@supabase/supabase-js';
import { AuthContext } from './auth-context';
import { RequireAuth, RequireRole } from './guards';
import {
  hasVerifiedFactor,
  mfaErrorMessage,
  mfaRequirement,
  sessionAal,
  totpCodeSchema,
} from './mfa';
import { useProfile } from './profile';

vi.mock('./profile', () => ({ useProfile: vi.fn() }));
vi.mock('./mfa-api', () => ({
  useTotpFactors: () => ({ isPending: false, isError: false, data: [] }),
  useEnrollTotp: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useVerifyTotp: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useUnenrollTotp: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

const b64url = (o: object) =>
  btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sessionWith = (aal: string) =>
  ({ access_token: `h.${b64url({ sub: 'u', aal })}.s` }) as unknown as Session;
const userWith = (statuses: string[]) =>
  ({ id: 'u', factors: statuses.map((status, i) => ({ id: `f${i}`, status })) }) as unknown as User;

describe('nível da sessão', () => {
  it('lê o aal do token', () => {
    expect(sessionAal(sessionWith('aal2'))).toBe('aal2');
    expect(sessionAal(sessionWith('aal1'))).toBe('aal1');
    expect(sessionAal({ access_token: 'quebrado' } as Session)).toBeNull();
    expect(sessionAal(null)).toBeNull();
  });

  it('decide entre seguir, pedir código ou exigir cadastro', () => {
    expect(hasVerifiedFactor(userWith(['unverified']))).toBe(false);
    const aal1 = sessionWith('aal1');
    expect(mfaRequirement({ session: aal1, user: userWith(['verified']), isStaff: false })).toBe(
      'verify',
    );
    expect(mfaRequirement({ session: aal1, user: userWith([]), isStaff: false })).toBe('ok');
    expect(mfaRequirement({ session: aal1, user: userWith(['unverified']), isStaff: true })).toBe(
      'enroll',
    );
    expect(
      mfaRequirement({ session: sessionWith('aal2'), user: userWith(['verified']), isStaff: true }),
    ).toBe('ok');
  });

  it('código de 6 dígitos e mensagens', () => {
    expect(totpCodeSchema.parse('123 456')).toBe('123456');
    expect(totpCodeSchema.safeParse('12345').success).toBe(false);
    expect(mfaErrorMessage({ code: 'mfa_verification_failed' })).toMatch(/Código incorreto/);
    expect(mfaErrorMessage({ code: 'mfa_totp_enroll_not_enabled' })).toMatch(/Supabase/);
    expect(mfaErrorMessage(null)).toMatch(/Tente de novo/);
  });
});

describe('guardas', () => {
  const routes = [
    { path: '/verificacao', element: <p>tela de código</p> },
    {
      element: <RequireAuth />,
      children: [
        { path: '/conta', element: <p>minha conta</p> },
        {
          element: <RequireRole allowed={['admin']} />,
          children: [{ path: '/admin', element: <p>painel admin</p> }],
        },
      ],
    },
  ];

  function renderAt(path: string, session: Session, user: User, role = 'seller') {
    vi.mocked(useProfile).mockReturnValue({
      isPending: false,
      isError: false,
      data: { role },
    } as unknown as ReturnType<typeof useProfile>);
    const router = createMemoryRouter(routes, { initialEntries: [path] });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AuthContext value={{ status: 'authenticated', session, user, signOut: vi.fn() }}>
          <RouterProvider router={router} />
        </AuthContext>
      </QueryClientProvider>,
    );
    return router;
  }

  it('com segundo fator e só senha, pede o código guardando o destino', async () => {
    const router = renderAt('/conta', sessionWith('aal1'), userWith(['verified']));
    expect(await screen.findByText('tela de código')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?next=%2Fconta');
  });

  it('equipe sem segundo fator vê o cadastro, não o painel; com aal2 entra', () => {
    renderAt('/admin', sessionWith('aal1'), userWith([]), 'admin');
    expect(screen.getByText('Ative a verificação em duas etapas')).toBeInTheDocument();
    expect(screen.queryByText('painel admin')).toBeNull();
  });

  it('equipe com aal2 entra no painel', () => {
    renderAt('/admin', sessionWith('aal2'), userWith(['verified']), 'admin');
    expect(screen.getByText('painel admin')).toBeInTheDocument();
  });
});
