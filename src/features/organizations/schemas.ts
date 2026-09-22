import { z } from 'zod';

/** Mirrors the `organizations.name` check constraint. */
export const organizationNameSchema = z
  .string()
  .trim()
  .min(2, 'Informe o nome da organização')
  .max(80, 'Use no máximo 80 caracteres');

export const organizationFormSchema = z.object({ name: organizationNameSchema });

export const inviteFormSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Informe o e-mail')
    .pipe(z.email({ error: 'E-mail inválido' })),
  role: z.enum(['member', 'admin']),
});

export type OrganizationFormValues = z.infer<typeof organizationFormSchema>;
export type InviteFormValues = z.infer<typeof inviteFormSchema>;
