import { z } from 'zod';
import { orgKinds } from '@/features/organizations/roles';

/** Gamificação (Fase 41): pontos, níveis, conquistas e ranking. */

const levelSchema = z.object({ name: z.string(), min_points: z.number().int() });

export const summarySchema = z.object({
  total: z.number().int(),
  month: z.number().int(),
  level: levelSchema.nullable(),
  next_level: levelSchema.nullable(),
  show_in_ranking: z.boolean(),
  rules: z.array(
    z.object({
      event: z.string(),
      label: z.string(),
      points: z.number().int(),
      daily_cap: z.number().int().nullable(),
    }),
  ),
  achievements: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      description: z.string(),
      threshold: z.number().int(),
      progress: z.number().int(),
      earned_at: z.string().nullable(),
    }),
  ),
  recent: z.array(
    z.object({
      event: z.string(),
      label: z.string(),
      points: z.number().int(),
      created_at: z.string(),
    }),
  ),
});
export type GamificationSummary = z.infer<typeof summarySchema>;

export const rankingSchema = z.object({
  month: z.string(),
  top: z.array(
    z.object({
      position: z.number().int(),
      name: z.string(),
      points: z.number().int(),
      is_me: z.boolean(),
    }),
  ),
  me: z.object({ position: z.number().int(), points: z.number().int() }).nullable(),
});
export type Ranking = z.infer<typeof rankingSchema>;

export const adminConfigSchema = z.object({
  rules: z.array(
    z.object({
      event: z.string(),
      label: z.string(),
      org_kind: z.enum(orgKinds).nullable(),
      points: z.number().int(),
      daily_cap: z.number().int().nullable(),
      enabled: z.boolean(),
    }),
  ),
  levels: z.array(
    z.object({ position: z.number().int(), name: z.string(), min_points: z.number().int() }),
  ),
  achievements: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      description: z.string(),
      event: z.string(),
      threshold: z.number().int(),
      active: z.boolean(),
    }),
  ),
  organizations_with_points: z.number().int(),
});
export type AdminGamificationConfig = z.infer<typeof adminConfigSchema>;

/** Progresso até o próximo nível, em %. Sem próximo nível: 100. */
export function levelProgress(s: Pick<GamificationSummary, 'total' | 'level' | 'next_level'>) {
  if (!s.next_level) return 100;
  const from = s.level?.min_points ?? 0;
  const span = s.next_level.min_points - from;
  if (span <= 0) return 100;
  return Math.max(0, Math.min(100, ((s.total - from) / span) * 100));
}

export const formatPoints = (n: number) =>
  `${n > 0 ? '+' : ''}${n.toLocaleString('pt-BR')} ${Math.abs(n) === 1 ? 'ponto' : 'pontos'}`;

/** "2026-10" → "outubro de 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return month;
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export interface LevelDraft {
  name: string;
  min_points: string;
}

/** Níveis da tela da equipe → envio; o banco confere o mesmo. */
export function validateLevels(levels: LevelDraft[]): {
  values: { name: string; min_points: number }[] | null;
  error: string | null;
} {
  if (levels.length === 0 || levels.length > 20)
    return { values: null, error: 'De 1 a 20 níveis.' };
  const values: { name: string; min_points: number }[] = [];
  for (const l of levels) {
    const name = l.name.trim();
    if (name.length < 2 || name.length > 40)
      return { values: null, error: 'Cada nível precisa de um nome (2 a 40 caracteres).' };
    if (!/^\d{1,9}$/.test(l.min_points.trim()))
      return { values: null, error: 'Pontos mínimos: número inteiro, sem sinal.' };
    values.push({ name, min_points: Number(l.min_points.trim()) });
  }
  const mins = values.map((v) => v.min_points);
  if (new Set(mins).size !== mins.length)
    return { values: null, error: 'Dois níveis não podem ter o mesmo mínimo.' };
  if (!mins.includes(0)) return { values: null, error: 'O primeiro nível começa em 0 pontos.' };
  return { values: [...values].sort((a, b) => a.min_points - b.min_points), error: null };
}

export const gamificationAuditLabels: Record<string, string> = {
  'gamification.rule': 'Pontuação alterada',
  'gamification.levels': 'Níveis alterados',
  'gamification.achievement': 'Conquista alterada',
};

const messages: Record<string, string> = {
  'org.forbidden': 'Sem permissão para esta ação.',
  'gamification.invalid': 'Dados inválidos. Revise os campos.',
  'gamification.invalid_levels': 'Níveis inválidos: nomes, mínimos diferentes e um começando em 0.',
  'gamification.not_found': 'Item não encontrado.',
  'admin.forbidden': 'Apenas a equipe da plataforma (com verificação em duas etapas).',
};

export function gamificationErrorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && messages[message]) return messages[message];
  return 'Não foi possível concluir. Tente de novo.';
}
