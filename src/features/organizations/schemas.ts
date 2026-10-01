import { z } from 'zod';
import { isValidCode } from '@/features/affiliates/affiliates';

/** Mirrors the `organizations.name` check constraint. */
export const organizationNameSchema = z
  .string()
  .trim()
  .min(2, 'Informe o nome da empresa')
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

export type OrganizationFormValues = z.infer<typeof organizationFormSchema>;
export type CreateOrganizationFormValues = z.infer<typeof createOrganizationFormSchema>;
