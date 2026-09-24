import { render, screen } from '@testing-library/react';
import {
  OrganizationContext,
  type OrganizationContextValue,
} from '@/features/organizations/organization-context';
import type { Membership } from '@/features/organizations/api';
import { SupplierApprovalNotice } from './components/SupplierApprovalNotice';
import {
  allowedActions,
  listingModerations,
  moderationAuditLabels,
  moderationErrorMessage,
  needsReason,
  validReason,
} from './moderation';

const approval = vi.hoisted(() => ({
  current: null as { approval_status: string; approval_reason: string | null } | null,
}));

vi.mock('./api', () => ({
  useSupplierApproval: (orgId: string | null) => ({
    data: orgId ? approval.current : undefined,
  }),
  useRequestSupplierReview: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

function renderNotice(kind: 'supplier' | 'seller', role: Membership['role'] = 'owner') {
  const membership: Membership = {
    role,
    organization: { id: '11111111-2222-4333-8444-555555555555', name: 'Fábrica X', kind },
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
      <SupplierApprovalNotice />
    </OrganizationContext>,
  );
}

describe('regras de moderação', () => {
  it('ações por estado espelham o banco', () => {
    expect(allowedActions('pending')).toEqual(['approve', 'reject', 'block']);
    expect(allowedActions('approved')).toEqual(['reject', 'block']);
    expect(allowedActions('rejected')).toEqual(['approve', 'block']);
    expect(allowedActions('blocked')).toEqual(['approve']);
    // Nunca oferece voltar ao mesmo estado.
    const target = { approve: 'approved', reject: 'rejected', block: 'blocked' } as const;
    for (const s of listingModerations) {
      for (const a of allowedActions(s)) expect(target[a]).not.toBe(s);
    }
  });

  it('motivo obrigatório para reprovar e bloquear, com 3 a 500 caracteres', () => {
    expect(needsReason('approve')).toBe(false);
    expect(needsReason('reject')).toBe(true);
    expect(needsReason('block')).toBe(true);
    expect(validReason('  ab  ')).toBe(false);
    expect(validReason('abc')).toBe(true);
    expect(validReason('x'.repeat(501))).toBe(false);
  });

  it('traduz erros e rotula a auditoria', () => {
    for (const code of [
      'moderation.invalid',
      'moderation.not_found',
      'moderation.no_change',
      'moderation.reason_required',
      'moderation.blocked',
    ]) {
      expect(moderationErrorMessage({ message: code })).not.toContain('moderation.');
    }
    expect(moderationErrorMessage({ message: 'fees.category_inactive' })).toMatch(/desativada/);
    expect(Object.keys(moderationAuditLabels)).toHaveLength(6);
  });
});

describe('aviso de aprovação do fornecedor', () => {
  it('não aparece para vendedor nem para fornecedor aprovado', () => {
    approval.current = { approval_status: 'pending', approval_reason: null };
    const { container, unmount } = renderNotice('seller');
    expect(container.textContent).toBe('');
    unmount();
    approval.current = { approval_status: 'approved', approval_reason: null };
    expect(renderNotice('supplier').container.textContent).toBe('');
  });

  it('em análise explica que os produtos aparecem depois da aprovação', () => {
    approval.current = { approval_status: 'pending', approval_reason: null };
    renderNotice('supplier');
    expect(screen.getByRole('status').textContent).toMatch(/em análise/);
  });

  it('reprovado mostra o motivo; só o proprietário pede nova análise', () => {
    approval.current = { approval_status: 'rejected', approval_reason: 'CNPJ não confere' };
    const { unmount } = renderNotice('supplier', 'owner');
    expect(screen.getByRole('alert').textContent).toMatch(/Motivo: CNPJ não confere/);
    expect(screen.getByRole('button', { name: /nova análise/ })).toBeTruthy();
    unmount();
    renderNotice('supplier', 'admin');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/Somente o proprietário/);
  });
});
