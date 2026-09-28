import type { Session, User } from '@supabase/supabase-js';
import { z } from 'zod';

/**
 * Verificação em duas etapas (Fase 26): TOTP do Supabase Auth.
 * O nível da sessão vem do próprio JWT (`aal`): aal1 = senha, aal2 = senha
 * + código. O banco confere o mesmo valor (`private.current_aal()`).
 */

export type Aal = 'aal1' | 'aal2';

/** `aal` do token de acesso (sem validar assinatura: é só para a tela). */
export function sessionAal(session: Session | null): Aal | null {
  const payload = session?.access_token?.split('.')[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const aal = (JSON.parse(json) as { aal?: unknown }).aal;
    return aal === 'aal2' ? 'aal2' : 'aal1';
  } catch {
    return null;
  }
}

export const hasVerifiedFactor = (user: User | null) =>
  (user?.factors ?? []).some((f) => f.status === 'verified');

/**
 * O que falta para a sessão: `verify` = tem segundo fator e entrou só com a
 * senha; `enroll` = equipe sem segundo fator; `ok` = nada.
 */
export function mfaRequirement(input: {
  session: Session | null;
  user: User | null;
  isStaff: boolean;
}): 'ok' | 'verify' | 'enroll' {
  if (!input.session) return 'ok';
  if (sessionAal(input.session) === 'aal2') return 'ok';
  if (hasVerifiedFactor(input.user)) return 'verify';
  return input.isStaff ? 'enroll' : 'ok';
}

export const totpCodeSchema = z
  .string()
  .transform((v) => v.replace(/\s/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'Digite os 6 números do aplicativo autenticador'));

export function mfaErrorMessage(error: unknown): string {
  const { message, code } = (error ?? {}) as { message?: unknown; code?: unknown };
  const text = typeof message === 'string' ? message : '';
  if (code === 'mfa_verification_failed' || /invalid.*(code|totp)/i.test(text))
    return 'Código incorreto ou expirado. Confira o horário do celular e tente de novo.';
  if (code === 'mfa_totp_enroll_not_enabled' || /not enabled/i.test(text))
    return 'Verificação em duas etapas desativada no projeto. Ative o TOTP no painel do Supabase (Authentication → MFA).';
  if (code === 'too_many_enrolled_mfa_factors')
    return 'Limite de aplicativos cadastrados. Remova um antes de adicionar outro.';
  if (code === 'insufficient_aal')
    return 'Para remover, entre com o código do aplicativo primeiro.';
  if (code === 'over_request_rate_limit' || /rate limit/i.test(text))
    return 'Muitas tentativas. Aguarde um pouco e tente de novo.';
  return 'Não foi possível concluir. Tente de novo.';
}
