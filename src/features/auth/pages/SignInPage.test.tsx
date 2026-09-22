import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthApiError } from '@supabase/supabase-js';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { SignInPage } from './SignInPage';

const auth = {
  signInWithPassword: vi.fn(),
  resend: vi.fn(),
};

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({ auth }) }));

function renderPage(path = '/entrar') {
  const router = createMemoryRouter([{ path: '/entrar', element: <SignInPage /> }], {
    initialEntries: [path],
  });
  render(<RouterProvider router={router} />);
}

async function submit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Entrar' }));
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('E-mail'), 'ana@example.com');
  await user.type(screen.getByLabelText('Senha'), 'Errada12345');
  await submit(user);
}

beforeEach(() => {
  auth.signInWithPassword.mockReset();
  auth.resend.mockReset();
});

describe('SignInPage', () => {
  it('valida os campos antes de chamar o servidor', async () => {
    const user = userEvent.setup();
    renderPage();
    await submit(user);
    expect(await screen.findByText('Informe seu e-mail')).toBeInTheDocument();
    expect(screen.getByText('Informe sua senha')).toBeInTheDocument();
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('envia e-mail normalizado e senha', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText('E-mail'), '  ana@example.com ');
    await user.type(screen.getByLabelText('Senha'), 'Senha12345');
    await submit(user);
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'ana@example.com',
      password: 'Senha12345',
    });
  });

  it('bloqueia o formulário após 3 senhas incorretas', async () => {
    auth.signInWithPassword.mockResolvedValue({
      error: new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'),
    });
    const user = userEvent.setup();
    renderPage();
    await fillAndSubmit(user);
    expect(await screen.findByText('E-mail ou senha incorretos.')).toBeInTheDocument();
    await submit(user);
    await submit(user);

    expect(await screen.findByText(/Tente novamente em 15s/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeDisabled();
    expect(auth.signInWithPassword).toHaveBeenCalledTimes(3);
  });

  it('oferece reenviar a confirmação quando o e-mail não foi confirmado', async () => {
    auth.signInWithPassword.mockResolvedValue({
      error: new AuthApiError('Email not confirmed', 400, 'email_not_confirmed'),
    });
    auth.resend.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    renderPage();
    await fillAndSubmit(user);
    await user.click(await screen.findByRole('button', { name: /Reenviar e-mail/ }));

    expect(auth.resend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'signup', email: 'ana@example.com' }),
    );
    expect(await screen.findByText(/novo link de confirmação foi enviado/)).toBeInTheDocument();
  });

  it('mostra o erro de link expirado vindo do e-mail', () => {
    renderPage('/entrar?error=access_denied&error_code=otp_expired');
    expect(screen.getByRole('alert')).toHaveTextContent('O link expirou');
  });
});
