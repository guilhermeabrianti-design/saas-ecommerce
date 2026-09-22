import { isAuthError } from '@supabase/supabase-js';

const messages: Partial<Record<string, string>> = {
  // Same message for wrong e-mail and wrong password: never reveal whether an account exists.
  invalid_credentials: 'E-mail ou senha incorretos.',
  email_not_confirmed: 'Confirme seu e-mail antes de entrar. Verifique sua caixa de entrada.',
  weak_password: 'Senha fraca. Siga os requisitos indicados.',
  same_password: 'A nova senha deve ser diferente da atual.',
  reauthentication_not_valid: 'Código de verificação inválido ou expirado.',
  otp_expired: 'O link expirou. Solicite um novo.',
  flow_state_expired: 'O link expirou. Solicite um novo.',
  flow_state_not_found: 'Link inválido. Abra o link no mesmo navegador em que fez a solicitação.',
  bad_code_verifier: 'Link inválido. Abra o link no mesmo navegador em que fez a solicitação.',
  session_expired: 'Sua sessão expirou. Entre novamente.',
  session_not_found: 'Sua sessão expirou. Entre novamente.',
  user_banned: 'Esta conta está bloqueada. Contate o suporte.',
  signup_disabled: 'Novos cadastros estão temporariamente desativados.',
  email_address_invalid: 'E-mail inválido.',
  captcha_failed: 'Verificação anti-robô falhou. Tente novamente.',
};

const RATE_LIMITED = 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';
const NETWORK = 'Não foi possível conectar ao servidor. Verifique sua conexão.';
const FALLBACK = 'Não foi possível concluir a operação. Tente novamente.';

/**
 * For errors Supabase appends to e-mail link redirects (`?error_code=otp_expired…`).
 * Returns null when there is no error code in the URL.
 */
export function authLinkErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return messages[code] ?? 'Link inválido ou expirado. Solicite um novo.';
}

/** Maps Supabase Auth errors to user-facing Portuguese messages. */
export function authErrorMessage(error: unknown): string {
  if (isAuthError(error)) {
    if (error.status === 429 || error.code?.startsWith('over_')) return RATE_LIMITED;
    const known = error.code ? messages[error.code] : undefined;
    if (known) return known;
    if (error.name === 'AuthRetryableFetchError') return NETWORK;
    return FALLBACK;
  }
  if (error instanceof TypeError) return NETWORK;
  return FALLBACK;
}
