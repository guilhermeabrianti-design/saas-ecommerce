import { render, screen } from '@testing-library/react';
import {
  OrganizationContext,
  type OrganizationContextValue,
} from '@/features/organizations/organization-context';
import type { Membership } from '@/features/organizations/api';
import { ledgerKindLabels } from '@/features/finance/schemas';
import { WalletPage } from './pages/WalletPage';
import {
  isValidPixKey,
  maskPixKey,
  normalizePixKey,
  walletErrorMessage,
  withdrawalFormSchema,
  type WalletSummary,
} from './wallet';

const mocks = vi.hoisted(() => ({ summary: null as unknown }));

vi.mock('./api', () => ({
  useWalletSummary: () => ({ isPending: false, isError: false, data: mocks.summary }),
  useWalletPending: () => ({ isPending: false, isError: false, data: [] }),
  useWithdrawals: () => ({ isPending: false, isError: false, data: [] }),
  useRequestWithdrawal: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useCancelWithdrawal: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

describe('chave PIX', () => {
  it('normaliza e valida como o banco', () => {
    expect(normalizePixKey('cpf', '123.456.789-09')).toBe('12345678909');
    expect(normalizePixKey('email', ' Loja@Example.com ')).toBe('loja@example.com');
    expect(isValidPixKey('cpf', '123.456.789-09')).toBe(true);
    expect(isValidPixKey('cpf', '111.111.111-11')).toBe(false);
    expect(isValidPixKey('cnpj', '11.222.333/0001-81')).toBe(true);
    expect(isValidPixKey('cnpj', '12345678909')).toBe(false);
    expect(isValidPixKey('phone', '(11) 98765-4321')).toBe(true);
    expect(isValidPixKey('phone', '0198765432')).toBe(false);
    expect(isValidPixKey('email', 'Loja@Example.com')).toBe(true);
    expect(isValidPixKey('email', 'sem-arroba')).toBe(false);
    expect(isValidPixKey('random', '123E4567-E89B-12D3-A456-426614174000')).toBe(true);
    expect(isValidPixKey('random', 'abc')).toBe(false);
  });

  it('mascara a chave na lista', () => {
    expect(maskPixKey('cpf', '12345678909')).toBe('*******8909');
    expect(maskPixKey('email', 'loja@example.com')).toBe('lo***@example.com');
  });
});

describe('formulário de saque', () => {
  const schema = withdrawalFormSchema(1000, 5000);
  const base = {
    amount: '20,00',
    pix_key_type: 'cpf',
    pix_key: '123.456.789-09',
    holder_name: 'Vendedor da Silva',
    holder_document: '123.456.789-09',
  };

  it('respeita mínimo e disponível', () => {
    expect(schema.safeParse(base).success).toBe(true);
    for (const amount of ['9,99', '50,01', 'abc', '']) {
      expect(schema.safeParse({ ...base, amount }).success).toBe(false);
    }
    expect(schema.safeParse({ ...base, amount: '50,00' }).success).toBe(true);
  });

  it('exige chave, titular e documento válidos', () => {
    expect(schema.safeParse({ ...base, pix_key_type: 'email' }).success).toBe(false);
    expect(schema.safeParse({ ...base, holder_name: ' ' }).success).toBe(false);
    expect(schema.safeParse({ ...base, holder_document: '000.000.000-00' }).success).toBe(false);
  });

  it('mensagens de erro e rótulo do razão', () => {
    expect(walletErrorMessage({ message: 'wallet.insufficient' })).toBe(
      'Saldo disponível insuficiente.',
    );
    expect(walletErrorMessage({ message: 'wallet.forbidden' })).toMatch(/proprietário/);
    expect(ledgerKindLabels.withdrawal).toBe('Saque');
  });
});

describe('tela da carteira', () => {
  const summary: WalletSummary = {
    available_cents: 8990,
    pending_cents: 2000,
    blocked_cents: 0,
    withdrawn_cents: 0,
    min_withdrawal_cents: 1000,
    release_days_after_delivery: 7,
    release_days_after_shipping: 30,
    can_withdraw: true,
  };

  function renderWallet(role: Membership['role'], s: WalletSummary) {
    mocks.summary = s;
    const membership: Membership = {
      role,
      organization: { id: '99999999-2222-4333-8444-555555555555', name: 'Loja V', kind: 'seller' },
    };
    const value: OrganizationContextValue = {
      memberships: [membership],
      isPending: false,
      isError: false,
      active: membership,
      selectOrganization: () => {},
    };
    return render(
      <OrganizationContext value={value}>
        <WalletPage />
      </OrganizationContext>,
    );
  }

  it('proprietário vê saldos e solicita saque', () => {
    renderWallet('owner', summary);
    expect(screen.getByText('R$ 89,90')).toBeInTheDocument();
    expect(screen.getByText(/7 dias após a entrega ou 30 dias/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Solicitar saque' })).toBeInTheDocument();
  });

  it('administrador vê, mas não saca; abaixo do mínimo não mostra o formulário', () => {
    const { unmount } = renderWallet('admin', { ...summary, can_withdraw: false });
    expect(screen.queryByRole('button', { name: 'Solicitar saque' })).toBeNull();
    expect(screen.getByText(/Só o proprietário/)).toBeInTheDocument();
    unmount();

    renderWallet('owner', { ...summary, available_cents: 500 });
    expect(screen.queryByRole('button', { name: 'Solicitar saque' })).toBeNull();
    expect(screen.getByText(/O saque mínimo é de R\$ 10,00/)).toBeInTheDocument();
  });

  it('membro não vê a carteira; saldo negativo é explicado', () => {
    const { unmount } = renderWallet('member', summary);
    expect(screen.getByText(/apenas para proprietários e administradores/)).toBeInTheDocument();
    unmount();

    renderWallet('owner', { ...summary, available_cents: -800 });
    expect(screen.getByText(/chegou depois da liberação/)).toBeInTheDocument();
  });
});
