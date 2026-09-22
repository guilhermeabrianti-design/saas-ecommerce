import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';
import { authErrorMessage, authLinkErrorMessage } from './errors';
import { safeNextPath } from './redirect';
import { hasRole } from './roles';
import { newPasswordSchema, signInSchema, signUpSchema } from './schemas';
import { lockSecondsAfter } from './throttle';

describe('signUpSchema', () => {
  const valid = {
    fullName: 'Ana Souza',
    email: 'ana@example.com',
    password: 'Senha12345',
    confirmPassword: 'Senha12345',
    accountType: 'seller',
  };

  it('aceita um cadastro válido e normaliza o e-mail', () => {
    const parsed = signUpSchema.parse({ ...valid, email: '  ana@example.com ' });
    expect(parsed.email).toBe('ana@example.com');
  });

  it.each([
    ['curta', 'Ab1'],
    ['sem maiúscula', 'senha12345'],
    ['sem minúscula', 'SENHA12345'],
    ['sem número', 'SenhaSemNumero'],
    ['longa demais', `Aa1${'x'.repeat(70)}`],
  ])('rejeita senha %s', (_label, password) => {
    const result = signUpSchema.safeParse({ ...valid, password, confirmPassword: password });
    expect(result.success).toBe(false);
  });

  it('rejeita confirmação diferente, apontando o campo certo', () => {
    const result = signUpSchema.safeParse({ ...valid, confirmPassword: 'Outra12345' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['confirmPassword']);
  });

  it('não permite escolher admin no cadastro', () => {
    expect(signUpSchema.safeParse({ ...valid, accountType: 'admin' }).success).toBe(false);
  });

  it('rejeita e-mail inválido e nome curto', () => {
    expect(signUpSchema.safeParse({ ...valid, email: 'ana@' }).success).toBe(false);
    expect(signUpSchema.safeParse({ ...valid, fullName: ' A ' }).success).toBe(false);
  });
});

describe('signInSchema / newPasswordSchema', () => {
  it('login não aplica a política de senha (contas antigas)', () => {
    expect(signInSchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
    expect(signInSchema.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
  });

  it('nova senha exige política e confirmação', () => {
    expect(
      newPasswordSchema.safeParse({ password: 'Senha12345', confirmPassword: 'Senha12345' })
        .success,
    ).toBe(true);
    expect(
      newPasswordSchema.safeParse({ password: 'fraca', confirmPassword: 'fraca' }).success,
    ).toBe(false);
  });
});

describe('authErrorMessage', () => {
  it('não revela se o e-mail existe em credenciais inválidas', () => {
    expect(authErrorMessage(new AuthApiError('Invalid', 400, 'invalid_credentials'))).toBe(
      'E-mail ou senha incorretos.',
    );
  });

  it('trata rate limit pelo status 429 e pelos códigos over_*', () => {
    expect(authErrorMessage(new AuthApiError('x', 429, undefined))).toMatch(/Muitas tentativas/);
    expect(authErrorMessage(new AuthApiError('x', 400, 'over_email_send_rate_limit'))).toMatch(
      /Muitas tentativas/,
    );
  });

  it('trata falhas de rede', () => {
    expect(authErrorMessage(new AuthRetryableFetchError('fetch failed', 0))).toMatch(/conectar/);
    expect(authErrorMessage(new TypeError('Failed to fetch'))).toMatch(/conectar/);
  });

  it('nunca expõe a mensagem crua do servidor', () => {
    const msg = authErrorMessage(
      new AuthApiError('internal detail xyz', 500, 'unexpected_failure'),
    );
    expect(msg).not.toMatch(/xyz/);
  });
});

describe('authLinkErrorMessage', () => {
  it('retorna null sem código e uma mensagem para códigos conhecidos ou não', () => {
    expect(authLinkErrorMessage(null)).toBeNull();
    expect(authLinkErrorMessage('otp_expired')).toMatch(/expirou/);
    expect(authLinkErrorMessage('qualquer_coisa')).toMatch(/inválido ou expirado/);
  });
});

describe('lockSecondsAfter', () => {
  it('libera as primeiras tentativas e depois aplica backoff exponencial com teto', () => {
    expect([0, 1, 2].map(lockSecondsAfter)).toEqual([0, 0, 0]);
    expect(lockSecondsAfter(3)).toBe(15);
    expect(lockSecondsAfter(4)).toBe(30);
    expect(lockSecondsAfter(5)).toBe(60);
    expect(lockSecondsAfter(50)).toBe(300);
  });
});

describe('safeNextPath', () => {
  it.each([
    ['/conta', '/conta'],
    ['/conta?aba=senha#x', '/conta?aba=senha#x'],
    [null, '/'],
    ['', '/'],
    ['conta', '/'],
    ['//evil.com', '/'],
    ['/\\evil.com', '/'],
    ['https://evil.com', '/'],
    ['javascript:alert(1)', '/'],
  ])('%s → %s', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});

describe('hasRole', () => {
  it('confere o papel contra a lista permitida', () => {
    expect(hasRole('admin', ['admin'])).toBe(true);
    expect(hasRole('seller', ['admin', 'supplier'])).toBe(false);
    expect(hasRole(null, ['seller'])).toBe(false);
    expect(hasRole(undefined, ['seller'])).toBe(false);
  });
});
