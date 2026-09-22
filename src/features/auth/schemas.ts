import { z } from 'zod';
import { signUpRoles } from './roles';

/** Must match `[auth] minimum_password_length` / `password_requirements` in supabase/config.toml. */
export const PASSWORD_MIN_LENGTH = 10;
/** bcrypt ignores bytes beyond 72. */
export const PASSWORD_MAX_LENGTH = 72;

export const passwordRules = [
  {
    test: (v: string) => v.length >= PASSWORD_MIN_LENGTH,
    label: `${PASSWORD_MIN_LENGTH}+ caracteres`,
  },
  { test: (v: string) => /[a-z]/.test(v), label: 'Letra minúscula' },
  { test: (v: string) => /[A-Z]/.test(v), label: 'Letra maiúscula' },
  { test: (v: string) => /\d/.test(v), label: 'Número' },
] as const;

const emailSchema = z
  .string()
  .trim()
  .min(1, 'Informe seu e-mail')
  .pipe(z.email({ error: 'E-mail inválido' }));

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use no mínimo ${PASSWORD_MIN_LENGTH} caracteres`)
  .max(PASSWORD_MAX_LENGTH, `Use no máximo ${PASSWORD_MAX_LENGTH} caracteres`)
  .regex(/[a-z]/, 'Inclua ao menos uma letra minúscula')
  .regex(/[A-Z]/, 'Inclua ao menos uma letra maiúscula')
  .regex(/\d/, 'Inclua ao menos um número');

/** Mirrors the `profiles.full_name` check constraint. */
export const fullNameSchema = z
  .string()
  .trim()
  .min(2, 'Informe seu nome')
  .max(120, 'Use no máximo 120 caracteres');

const passwordsMatch = <T extends { password: string; confirmPassword: string }>(v: T) =>
  v.password === v.confirmPassword;
const mismatch = { error: 'As senhas não coincidem', path: ['confirmPassword'] };

export const signInSchema = z.object({
  email: emailSchema,
  // No policy check on sign-in: accounts may predate the current policy.
  password: z.string().min(1, 'Informe sua senha'),
});

export const signUpSchema = z
  .object({
    fullName: fullNameSchema,
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    accountType: z.enum(signUpRoles, { error: 'Escolha o tipo de conta' }),
  })
  .refine(passwordsMatch, mismatch);

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const newPasswordSchema = z
  .object({ password: passwordSchema, confirmPassword: z.string() })
  .refine(passwordsMatch, mismatch);

export const profileFormSchema = z.object({ fullName: fullNameSchema });

export type SignInValues = z.infer<typeof signInSchema>;
export type SignUpValues = z.infer<typeof signUpSchema>;
export type ForgotPasswordValues = z.infer<typeof forgotPasswordSchema>;
export type NewPasswordValues = z.infer<typeof newPasswordSchema>;
export type ProfileFormValues = z.infer<typeof profileFormSchema>;
