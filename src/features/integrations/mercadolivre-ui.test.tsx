import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MercadoLivreConnect } from './components/MercadoLivreConnect';
import { connectErrorMessage, mercadoLivreReturnMessages } from './mercadolivre';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({ functions: { invoke } }),
}));

const renderConnect = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MercadoLivreConnect orgId="99999999-2222-4333-8444-555555555555" />
    </QueryClientProvider>,
  );

describe('Mercado Livre na tela', () => {
  it('mensagens de retorno e de erro', () => {
    expect(mercadoLivreReturnMessages.conta_em_uso!.text).toMatch(/outra loja/);
    expect(connectErrorMessage('not_configured')).toMatch(/app do Mercado Livre/);
    expect(connectErrorMessage(null)).toMatch(/Tente de novo/);
  });

  it('pede a URL e leva para a autorização do Mercado Livre', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    invoke.mockResolvedValueOnce({
      data: { url: 'https://auth.mercadolivre.com.br/authorization?client_id=1' },
      error: null,
    });
    renderConnect();
    await userEvent.click(screen.getByRole('button', { name: 'Conectar Mercado Livre' }));
    expect(invoke).toHaveBeenCalledWith('mercadolivre/connect', {
      body: { organization_id: '99999999-2222-4333-8444-555555555555', name: 'Mercado Livre' },
    });
    expect(assign).toHaveBeenCalledWith(
      'https://auth.mercadolivre.com.br/authorization?client_id=1',
    );
    vi.unstubAllGlobals();
  });

  it('não segue para URL fora do Mercado Livre', async () => {
    invoke.mockResolvedValueOnce({ data: { url: 'https://evil.example/login' }, error: null });
    renderConnect();
    await userEvent.click(screen.getByRole('button', { name: 'Conectar Mercado Livre' }));
    expect(await screen.findByText(/Não foi possível iniciar a conexão/)).toBeInTheDocument();
  });
});
