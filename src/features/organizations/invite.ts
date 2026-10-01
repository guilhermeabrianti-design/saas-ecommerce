import { z } from 'zod';
import { orgKinds, orgRoles } from './roles';

/**
 * Convite por link: quem recebe abre /convite/<token>, cria a conta (o tipo
 * vem da empresa) e já entra. O token fica guardado até a pessoa entrar
 * (confirmação de e-mail no meio do caminho), por no máximo 7 dias.
 */

const KEY = 'ts-invite-token';
const DAYS = 7;
const DAY = 86_400_000;
const TOKEN = /^[0-9a-f]{64}$/;

export const isInviteToken = (v: string | null | undefined): v is string => !!v && TOKEN.test(v);

export const inviteUrl = (origin: string, token: string) => `${origin}/convite/${token}`;

export function rememberInviteToken(token: string, now = Date.now()) {
  if (!isInviteToken(token)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ token, at: now }));
  } catch {
    // sem armazenamento: o convite vale só nesta aba
  }
}

export function pendingInviteToken(now = Date.now()): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = z.object({ token: z.string(), at: z.number() }).parse(JSON.parse(raw));
    return now - parsed.at > DAYS * DAY || !isInviteToken(parsed.token) ? null : parsed.token;
  } catch {
    return null;
  }
}

export function clearInviteToken() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nada a limpar
  }
}

export const invitePreviewSchema = z
  .object({
    organization_name: z.string(),
    kind: z.enum(orgKinds),
    role: z.enum(orgRoles),
    expires_at: z.string(),
  })
  .nullable();
export type InvitePreview = z.infer<typeof invitePreviewSchema>;

const messages: Record<string, string> = {
  'org.invitation_not_found': 'Este link de convite não vale mais (usado, vencido ou cancelado).',
  'org.account_type_mismatch':
    'Esta conta é de outro tipo (vendedor/fornecedor). Entre com outra conta ou crie uma nova pelo link.',
  'org.already_in_company':
    'Esta conta já tem uma empresa com dados. Use outro e-mail para entrar nesta equipe.',
};

export function inviteErrorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && messages[message]) return messages[message];
  return 'Não foi possível usar o convite. Tente de novo.';
}
