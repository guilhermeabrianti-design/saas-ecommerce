import { z } from 'zod';
import { orgErrorMessage } from '@/features/organizations/errors';
import { isValidCnpj, isValidCpf, isValidDocument, isValidPhone, onlyDigits } from '@/utils/br';
import { parseBRL } from '@/utils/money';

/** Espelha `public.withdrawal_status` / `public.pix_key_type` (supabase/migrations/*_wallet.sql). */
export const withdrawalStatuses = [
  'requested',
  'approved',
  'paid',
  'rejected',
  'cancelled',
] as const;
export type WithdrawalStatus = (typeof withdrawalStatuses)[number];

export const withdrawalStatusLabels: Record<WithdrawalStatus, string> = {
  requested: 'Solicitado',
  approved: 'Aprovado',
  paid: 'Pago',
  rejected: 'Recusado',
  cancelled: 'Cancelado',
};

export const pixKeyTypes = ['cpf', 'cnpj', 'email', 'phone', 'random'] as const;
export type PixKeyType = (typeof pixKeyTypes)[number];

export const pixKeyTypeLabels: Record<PixKeyType, string> = {
  cpf: 'CPF',
  cnpj: 'CNPJ',
  email: 'E-mail',
  phone: 'Celular',
  random: 'Chave aleatória',
};

/** Mesma normalização de `private.normalize_pix_key`. */
export function normalizePixKey(type: PixKeyType, key: string): string {
  return type === 'cpf' || type === 'cnpj' || type === 'phone'
    ? onlyDigits(key)
    : key.trim().toLowerCase();
}

/** Mesmas regras de `private.is_valid_pix_key` (sobre a chave normalizada). */
export function isValidPixKey(type: PixKeyType, raw: string): boolean {
  const key = normalizePixKey(type, raw);
  switch (type) {
    case 'cpf':
      return /^\d{11}$/.test(key) && isValidCpf(key);
    case 'cnpj':
      return /^\d{14}$/.test(key) && isValidCnpj(key);
    case 'phone':
      return isValidPhone(key);
    case 'email':
      return key.length <= 77 && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(key);
    case 'random':
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key);
  }
}

export const walletSummarySchema = z.object({
  available_cents: z.number().int(),
  pending_cents: z.number().int(),
  blocked_cents: z.number().int(),
  withdrawn_cents: z.number().int(),
  min_withdrawal_cents: z.number().int(),
  release_days_after_delivery: z.number().int(),
  release_days_after_shipping: z.number().int(),
  can_withdraw: z.boolean(),
});
export type WalletSummary = z.infer<typeof walletSummarySchema>;

export const pendingCreditSchema = z.object({
  order_id: z.uuid(),
  description: z.string().nullable(),
  amount_cents: z.number().int(),
  release_at: z.string().nullable(),
  created_at: z.string(),
});
export type PendingCredit = z.infer<typeof pendingCreditSchema>;

export const withdrawalSchema = z.object({
  id: z.uuid(),
  amount_cents: z.number().int(),
  status: z.enum(withdrawalStatuses),
  pix_key_type: z.enum(pixKeyTypes),
  pix_key: z.string(),
  holder_name: z.string(),
  rejection_reason: z.string().nullable(),
  payout_reference: z.string().nullable(),
  created_at: z.string(),
  paid_at: z.string().nullable(),
});
export type Withdrawal = z.infer<typeof withdrawalSchema>;

/** Formulário de saque; `min`/`max` vêm do resumo da carteira. */
export function withdrawalFormSchema(minCents: number, maxCents: number) {
  return z
    .object({
      amount: z.string(),
      pix_key_type: z.enum(pixKeyTypes),
      pix_key: z.string(),
      holder_name: z
        .string()
        .trim()
        .min(2, 'Informe o nome do titular')
        .max(120, 'Máximo de 120 caracteres'),
      holder_document: z
        .string()
        .refine((v) => isValidDocument(onlyDigits(v)), { error: 'CPF ou CNPJ inválido' }),
    })
    .superRefine((v, ctx) => {
      const cents = parseBRL(v.amount);
      if (cents === null || cents < 1) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Valor inválido, ex.: 150,00' });
      } else if (cents < minCents) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Abaixo do valor mínimo' });
      } else if (cents > maxCents) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Maior que o disponível' });
      }
      if (!isValidPixKey(v.pix_key_type, v.pix_key)) {
        ctx.addIssue({ code: 'custom', path: ['pix_key'], message: 'Chave PIX inválida' });
      }
    });
}
export type WithdrawalFormValues = z.infer<ReturnType<typeof withdrawalFormSchema>>;

/** Mascara a chave na lista (a completa só aparece para a equipe). */
export function maskPixKey(type: PixKeyType, key: string): string {
  if (type === 'email') {
    const [user = '', domain = ''] = key.split('@');
    return `${user.slice(0, 2)}***@${domain}`;
  }
  if (key.length <= 4) return key;
  return `${'*'.repeat(Math.min(key.length - 4, 8))}${key.slice(-4)}`;
}

const messages: Partial<Record<string, string>> = {
  'wallet.forbidden': 'Só o proprietário da organização pode solicitar saques.',
  'wallet.invalid': 'Requisição inválida.',
  'wallet.invalid_pix_key': 'Chave PIX inválida para o tipo escolhido.',
  'wallet.invalid_holder': 'Informe nome e CPF/CNPJ válidos do titular.',
  'wallet.below_minimum': 'Valor abaixo do mínimo para saque.',
  'wallet.insufficient': 'Saldo disponível insuficiente.',
  'wallet.not_found': 'Saque não encontrado ou sem permissão.',
  'wallet.invalid_status': 'O saque mudou de situação. Atualize a página.',
  'wallet.reason_required': 'Informe o motivo (ao menos 3 caracteres).',
  'wallet.reference_required': 'Informe o identificador da transferência (ao menos 3 caracteres).',
  'wallet.organization_suspended': 'A organização está suspensa: o saque não pode ser aprovado.',
  'admin.forbidden': 'Acesso restrito à equipe da plataforma.',
};

export function walletErrorMessage(error: unknown): string {
  const { message } = (error ?? {}) as { message?: unknown };
  if (typeof message === 'string' && messages[message]) return messages[message];
  return orgErrorMessage(error);
}

export const walletAuditLabels: Record<string, string> = {
  'wallet.approve': 'Saque aprovado',
  'wallet.reject': 'Saque recusado',
  'wallet.pay': 'Saque pago',
  'wallet.settings': 'Regras da carteira alteradas',
};
