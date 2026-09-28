import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { AuthContext, type AuthContextValue } from '@/features/auth/auth-context';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { faqs, pricingPoints } from './content';
import { RootRoute } from './RootRoute';

vi.mock('@/layouts/AppShell', () => ({ AppShell: () => <p>app</p> }));

function renderRoot(status: AuthContextValue['status']) {
  const auth: AuthContextValue = { status, session: null, user: null, signOut: async () => {} };
  return render(
    <ThemeProvider>
      <AuthContext value={auth}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<RootRoute />} />
          </Routes>
        </MemoryRouter>
      </AuthContext>
    </ThemeProvider>,
  );
}

describe('landing page', () => {
  it('visitante vê a landing com chamadas para vendedor e fornecedor', () => {
    renderRoot('unauthenticated');
    expect(screen.getByRole('heading', { level: 1, name: /sem ter estoque/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Quero vender/ })).toHaveAttribute('href', '/cadastro');
    expect(screen.getByRole('link', { name: 'Sou fornecedor' })).toHaveAttribute(
      'href',
      '/cadastro?conta=fornecedor',
    );
    for (const id of ['como', 'vend', 'forn', 'acad', 'plan', 'duvidas']) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    const faq = screen.getByRole('region', { name: 'Perguntas e respostas' });
    expect(within(faq).getAllByRole('group')).toHaveLength(faqs.length);
  });

  it('sem conteúdo inventado: nada de depoimentos, números de clientes ou preços', () => {
    renderRoot('unauthenticated');
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/depoimento|clientes satisfeitos|\+\s?\d+ (vendedores|lojas)/i);
    expect(text).not.toMatch(/R\$\s?\d/);
    // Planos futuros aparecem como futuros.
    expect(pricingPoints.some((p) => /ainda não existem/.test(p))).toBe(true);
  });

  it('quem entrou vai para o app; ambiente sem Supabase também vê a landing', () => {
    const { unmount } = renderRoot('authenticated');
    expect(screen.getByText('app')).toBeInTheDocument();
    unmount();
    renderRoot('unconfigured');
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });
});
