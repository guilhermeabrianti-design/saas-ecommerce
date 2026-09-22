import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SystemStatusPage } from './SystemStatusPage';

describe('SystemStatusPage', () => {
  it('shows Supabase as "Não configurado" when env is missing', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SystemStatusPage />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('heading', { name: 'Status do sistema' })).toBeInTheDocument();
    expect(screen.getByText(/Não configurado/)).toBeInTheDocument();
  });
});
