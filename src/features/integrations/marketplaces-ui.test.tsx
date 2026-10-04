import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MarketplaceConnect } from './components/MarketplaceConnect';
import {
  connectErrorMessage,
  isAuthorizationUrl,
  returnMessage,
  returnMessageFromParams,
  type OAuthProvider,
} from './marketplaces';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({ functions: { invoke } }),
}));

const renderConnect = (provider: OAuthProvider) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MarketplaceConnect provider={provider} orgId="99999999-2222-4333-8444-555555555555" />
    </QueryClientProvider>,
  );

describe('Conexão de marketplace na tela', () => {
  it('mensagens de retorno e de erro', () => {
    expect(returnMessage('mercadolivre', 'conta_em_uso')!.text).toMatch(/outra loja/);
    expect(returnMessage('shopee', 'conectado')!.text).toMatch(/Shopee conectada/);
    expect(returnMessage('shopee', 'qualquer')).toBeNull();
    expect(returnMessageFromParams(new URLSearchParams('shopee=erro'))!.text).toMatch(/Shopee/);
    expect(returnMessageFromParams(new URLSearchParams('ml=erro'), 'shopee')).toBeNull();
    expect(connectErrorMessage('not_configured', 'mercadolivre')).toMatch(/app do Mercado Livre/);
    expect(connectErrorMessage('not_configured', 'shopee')).toMatch(/app da Shopee/);
    expect(connectErrorMessage(null, 'shopee')).toMatch(/Tente de novo/);
  });

  it('só aceita a página de autorização do próprio marketplace', () => {
    expect(
      isAuthorizationUrl('mercadolivre', 'https://auth.mercadolivre.com.br/authorization'),
    ).toBe(true);
    expect(
      isAuthorizationUrl('shopee', 'https://partner.shopeemobile.com/api/v2/shop/auth_partner?x=1'),
    ).toBe(true);
    expect(
      isAuthorizationUrl(
        'shopee',
        'https://partner.test-stable.shopeemobile.com/api/v2/shop/auth_partner',
      ),
    ).toBe(true);
    expect(isAuthorizationUrl('shopee', 'https://partner.shopeemobile.com.evil.example/')).toBe(
      false,
    );
    expect(isAuthorizationUrl('shopee', 'http://partner.shopeemobile.com/')).toBe(false);
    expect(isAuthorizationUrl('mercadolivre', 'https://partner.shopeemobile.com/')).toBe(false);
  });

  it('pede a URL e leva para a autorização do Mercado Livre', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    invoke.mockResolvedValueOnce({
      data: { url: 'https://auth.mercadolivre.com.br/authorization?client_id=1' },
      error: null,
    });
    renderConnect('mercadolivre');
    await userEvent.click(screen.getByRole('button', { name: 'Conectar Mercado Livre' }));
    expect(invoke).toHaveBeenCalledWith('mercadolivre/connect', {
      body: { organization_id: '99999999-2222-4333-8444-555555555555', name: 'Mercado Livre' },
    });
    expect(assign).toHaveBeenCalledWith(
      'https://auth.mercadolivre.com.br/authorization?client_id=1',
    );
    vi.unstubAllGlobals();
  });

  it('Shopee usa a própria função', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    invoke.mockResolvedValueOnce({
      data: { url: 'https://partner.shopeemobile.com/api/v2/shop/auth_partner?partner_id=1' },
      error: null,
    });
    renderConnect('shopee');
    await userEvent.click(screen.getByRole('button', { name: 'Conectar Shopee' }));
    expect(invoke).toHaveBeenCalledWith('shopee/connect', {
      body: { organization_id: '99999999-2222-4333-8444-555555555555', name: 'Shopee' },
    });
    expect(assign).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('não segue para URL fora do marketplace', async () => {
    invoke.mockResolvedValueOnce({ data: { url: 'https://evil.example/login' }, error: null });
    renderConnect('mercadolivre');
    await userEvent.click(screen.getByRole('button', { name: 'Conectar Mercado Livre' }));
    expect(await screen.findByText(/Não foi possível iniciar a conexão/)).toBeInTheDocument();
  });
});
