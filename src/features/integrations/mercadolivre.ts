/** Mensagens da volta do OAuth (`?ml=` na URL). */
export const mercadoLivreReturnMessages: Record<
  string,
  { tone: 'success' | 'error' | 'info'; text: string }
> = {
  conectado: {
    tone: 'success',
    text: 'Mercado Livre conectado. Os pedidos pagos passam a entrar sozinhos.',
  },
  cancelado: { tone: 'info', text: 'Conexão com o Mercado Livre cancelada.' },
  expirado: { tone: 'error', text: 'O tempo para autorizar acabou. Comece de novo.' },
  conta_em_uso: {
    tone: 'error',
    text: 'Esta conta do Mercado Livre já está ligada a outra loja na TheSigns. Desconecte lá primeiro.',
  },
  erro: {
    tone: 'error',
    text: 'Não foi possível concluir a conexão com o Mercado Livre. Tente de novo.',
  },
};

export function connectErrorMessage(code: string | null): string {
  if (code === 'not_configured')
    return 'O Mercado Livre ainda não foi configurado na plataforma: a equipe precisa cadastrar o app do Mercado Livre.';
  if (code === 'forbidden')
    return 'Só proprietários e administradores de lojas conectam marketplaces.';
  return 'Não foi possível iniciar a conexão. Tente de novo.';
}
