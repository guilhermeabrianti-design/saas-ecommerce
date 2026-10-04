import { providerLabels } from './schemas';

/** Marketplaces conectados por autorização (OAuth) pela Edge Function de mesmo nome. */
export const oauthProviders = ['mercadolivre', 'shopee'] as const;
export type OAuthProvider = (typeof oauthProviders)[number];

/** Parâmetro de volta da autorização na URL (`?ml=conectado`, `?shopee=erro`…). */
export const returnParam: Record<OAuthProvider, string> = {
  mercadolivre: 'ml',
  shopee: 'shopee',
};

/** Só seguimos para a página de autorização do próprio marketplace. */
export function isAuthorizationUrl(provider: OAuthProvider, raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (provider === 'mercadolivre') return url.hostname === 'auth.mercadolivre.com.br';
  return /^partner(\.test-stable)?\.shopeemobile\.com$/.test(url.hostname);
}

type Tone = 'success' | 'error' | 'info';

const connectedText: Record<OAuthProvider, string> = {
  mercadolivre: 'Mercado Livre conectado. Os pedidos pagos passam a entrar sozinhos.',
  shopee: 'Shopee conectada. Os pedidos pagos passam a entrar sozinhos.',
};

/** Mensagem da volta da autorização, ou null para código desconhecido. */
export function returnMessage(
  provider: OAuthProvider,
  code: string | null,
): { tone: Tone; text: string } | null {
  const name = providerLabels[provider];
  switch (code) {
    case 'conectado':
      return { tone: 'success', text: connectedText[provider] };
    case 'cancelado':
      return { tone: 'info', text: `Conexão com ${name} cancelada.` };
    case 'expirado':
      return { tone: 'error', text: 'O tempo para autorizar acabou. Comece de novo.' };
    case 'conta_em_uso':
      return {
        tone: 'error',
        text: `Esta conta ${provider === 'mercadolivre' ? 'do' : 'da'} ${name} já está ligada a outra loja na TheSigns. Desconecte lá primeiro.`,
      };
    case 'erro':
      return {
        tone: 'error',
        text: `Não foi possível concluir a conexão com ${name}. Tente de novo.`,
      };
    default:
      return null;
  }
}

/** Primeira mensagem de volta presente na URL (qualquer marketplace). */
export function returnMessageFromParams(
  params: URLSearchParams,
  only?: OAuthProvider,
): { tone: Tone; text: string } | null {
  for (const provider of oauthProviders) {
    if (only && provider !== only) continue;
    const message = returnMessage(provider, params.get(returnParam[provider]));
    if (message) return message;
  }
  return null;
}

export function connectErrorMessage(code: string | null, provider: OAuthProvider): string {
  const name = providerLabels[provider];
  if (code === 'not_configured')
    return `${name} ainda não foi configurado na plataforma: a equipe precisa cadastrar o app ${provider === 'mercadolivre' ? 'do' : 'da'} ${name}.`;
  if (code === 'forbidden')
    return 'Só proprietários e administradores de lojas conectam marketplaces.';
  return 'Não foi possível iniciar a conexão. Tente de novo.';
}
