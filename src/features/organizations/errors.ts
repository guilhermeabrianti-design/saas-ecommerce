const messages: Partial<Record<string, string>> = {
  'org.forbidden': 'Você não tem permissão para esta ação nesta organização.',
  'org.account_type_not_allowed': 'Contas da equipe TheSigns não criam organizações de clientes.',
  'org.limit_reached': 'Limite atingido. Remova itens antigos ou contate o suporte.',
  'org.invalid_role': 'Seu papel não permite convidar com esse nível de acesso.',
  'org.already_member': 'Este e-mail já é membro da organização.',
  'org.invitation_not_found': 'Convite não encontrado ou expirado.',
  'org.account_type_mismatch':
    'O tipo da sua conta não corresponde ao tipo desta organização (vendedor/fornecedor).',
  'org.member_not_found': 'Membro não encontrado. Atualize a página.',
  'referral.disabled': 'O programa de indicação está pausado. Deixe o código em branco.',
  'referral.invalid_code': 'Código de indicação não encontrado. Confira ou deixe em branco.',
  'referral.self': 'Não vale indicar a si mesmo. Deixe o código em branco.',
  rate_limited: 'Muitas operações seguidas. Aguarde um pouco e tente de novo.',
  'org.last_owner':
    'A organização precisa de ao menos um proprietário. Promova outra pessoa antes.',
};

const FALLBACK = 'Não foi possível concluir a operação. Tente novamente.';

/** Maps PostgREST errors from organization RPCs to user-facing messages. */
export function orgErrorMessage(error: unknown): string {
  if (error instanceof TypeError)
    return 'Não foi possível conectar ao servidor. Verifique sua conexão.';
  if (typeof error !== 'object' || error === null) return FALLBACK;
  const { message, code } = error as { message?: unknown; code?: unknown };
  if (typeof message === 'string' && messages[message]) return messages[message];
  if (code === '23514') return 'Dados inválidos. Revise os campos.';
  if (code === '42501') return messages['org.forbidden']!;
  return FALLBACK;
}
