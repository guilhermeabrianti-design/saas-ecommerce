import { z } from 'zod';
import { isValidCode } from '@/features/affiliates/affiliates';

/** Mirrors the `organizations.name` check constraint. */
export const organizationNameSchema = z
  .string()
  .trim()
  .min(2, 'Informe o nome da organização')
  .max(80, 'Use no máximo 80 caracteres');

export const organizationFormSchema = z.object({ name: organizationNameSchema });

/** Criação: nome + código de indicação opcional (Fase 23). */
export const createOrganizationFormSchema = organizationFormSchema.extend({
  referral_code: z
    .string()
    .refine(
      (v) => v.trim() === '' || isValidCode(v),
      'Código inválido. Confira ou deixe em branco.',
    ),
});

export const inviteFormSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Informe o e-mail')
    .pipe(z.email({ error: 'E-mail inválido' })),
  role: z.enum(['member', 'admin']),
});

export type OrganizationFormValues = z.infer<typeof organizationFormSchema>;
export type CreateOrganizationFormValues = z.infer<typeof createOrganizationFormSchema>;
export type InviteFormValues = z.infer<typeof inviteFormSchema>;
