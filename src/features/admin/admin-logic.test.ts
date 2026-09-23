import { adminErrorMessage, auditActionLabels } from './api';

describe('mensagens de admin', () => {
  it('traduz cada erro de regra e cai nos erros de organização', () => {
    for (const code of [
      'admin.forbidden',
      'admin.not_found',
      'admin.no_change',
      'admin.reason_required',
      'admin.invalid',
    ]) {
      const text = adminErrorMessage({ message: code });
      expect(text).not.toBe('Não foi possível concluir a operação. Tente novamente.');
      expect(text).not.toContain('admin.');
    }
    expect(adminErrorMessage({ message: 'org.forbidden' })).toMatch(/permissão/);
  });

  it('rotula as ações de auditoria conhecidas', () => {
    expect(auditActionLabels['organization.suspended']).toBeTruthy();
    expect(auditActionLabels['organization.reactivated']).toBeTruthy();
  });
});
