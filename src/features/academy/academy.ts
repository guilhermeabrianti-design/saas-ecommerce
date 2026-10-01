import { z } from 'zod';
import { orgErrorMessage } from '@/features/organizations/errors';

export const courseLevels = ['beginner', 'intermediate', 'advanced'] as const;
export type CourseLevel = (typeof courseLevels)[number];
export const levelLabels: Record<CourseLevel, string> = {
  beginner: 'Iniciante',
  intermediate: 'Intermediário',
  advanced: 'Avançado',
};

export const courseStatuses = ['draft', 'published', 'archived'] as const;
export type CourseStatus = (typeof courseStatuses)[number];
export const courseStatusLabels: Record<CourseStatus, string> = {
  draft: 'Rascunho',
  published: 'Liberado',
  archived: 'Bloqueado',
};

export const courseAudiences = ['all', 'seller', 'supplier'] as const;
export type CourseAudience = (typeof courseAudiences)[number];
export const audienceLabels: Record<CourseAudience, string> = {
  all: 'Todos',
  seller: 'Vendedores',
  supplier: 'Fornecedores',
};

export const unlockRules = [
  'none',
  'previous_lesson',
  'previous_module',
  'admin_approval',
] as const;
export type UnlockRule = (typeof unlockRules)[number];
export const unlockRuleLabels: Record<UnlockRule, string> = {
  none: 'Livre',
  previous_lesson: 'Após concluir a aula anterior',
  previous_module: 'Após concluir o módulo anterior',
  admin_approval: 'Após aprovação da equipe',
};

/**
 * Telas do app que uma aula pode abrir ("aprendizado em ação"). Só caminhos
 * desta lista são oferecidos; o banco também valida o formato.
 */
export const lessonActions = [
  { path: '/catalogo', label: 'Escolher produto no catálogo' },
  { path: '/produtos/novo', label: 'Cadastrar produto' },
  { path: '/produtos', label: 'Ver meus produtos' },
  { path: '/integracoes', label: 'Conectar marketplace' },
  { path: '/pedidos', label: 'Acompanhar pedidos' },
  { path: '/pedidos/novo', label: 'Registrar pedido' },
  { path: '/estoque', label: 'Controlar estoque' },
  { path: '/analises', label: 'Analisar métricas' },
  { path: '/carteira', label: 'Ver carteira' },
] as const;

export const isKnownAction = (path: string) => lessonActions.some((a) => a.path === path);

/**
 * Id do vídeo a partir do que a equipe cola: link do YouTube (watch, youtu.be,
 * shorts, embed, live) ou o próprio id de 11 caracteres.
 */
export function parseYouTubeId(input: string): string | null {
  const text = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text.startsWith('http') ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1] ?? null;
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const [, kind, value] = url.pathname.split('/');
      if (kind && ['shorts', 'embed', 'live', 'v'].includes(kind)) id = value ?? null;
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** "1h 05min", "12min", "45s". */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}min`;
  if (m > 0) return `${m}min`;
  return `${seconds}s`;
}

/** "mm:ss" ou "h:mm:ss" (campo de duração da aula). */
export function parseClock(input: string): number | null {
  const parts = input.trim().split(':');
  if (parts.length < 1 || parts.length > 3 || parts.some((p) => !/^\d{1,2}$/.test(p))) {
    return /^\d{1,5}$/.test(input.trim()) ? Number(input.trim()) : null;
  }
  const nums = parts.map(Number);
  if (nums.slice(1).some((n) => n >= 60)) return null;
  const total = nums.reduce((acc, n) => acc * 60 + n, 0);
  return total <= 86400 ? total : null;
}

export function formatClock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------
// Esquemas
// ---------------------------------------------------------------------
const int = z.coerce.number().int();

export const catalogCourseSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string(),
  level: z.enum(courseLevels),
  cover_path: z.string().nullable(),
  certificate_enabled: z.boolean(),
  modules: int,
  lessons: int,
  duration_seconds: int,
  lessons_done: int,
  percent: int,
  completed: z.boolean(),
  certificate_id: z.uuid().nullable(),
  last_activity: z.string().nullable(),
});
export type CatalogCourse = z.infer<typeof catalogCourseSchema>;

export const summarySchema = z.object({
  lessons_total: int,
  lessons_done: int,
  modules_total: int,
  modules_done: int,
  percent: int,
  completed: z.boolean(),
});

export const outlineSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string(),
  level: z.enum(courseLevels),
  cover_path: z.string().nullable(),
  certificate_enabled: z.boolean(),
  summary: summarySchema,
  resume_lesson_id: z.uuid().nullable(),
  certificate_id: z.uuid().nullable(),
  modules: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      description: z.string(),
      lessons: z.array(
        z.object({
          id: z.uuid(),
          title: z.string(),
          duration_seconds: int,
          is_required: z.boolean(),
          unlock_rule: z.enum(unlockRules),
          unlocked: z.boolean(),
          unlock_requested: z.boolean(),
          completed: z.boolean(),
          percent: int,
        }),
      ),
    }),
  ),
});
export type CourseOutline = z.infer<typeof outlineSchema>;
export type OutlineLesson = CourseOutline['modules'][number]['lessons'][number];

export const lessonSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string(),
  youtube_id: z.string().nullable(),
  duration_seconds: int,
  is_required: z.boolean(),
  action_label: z.string().nullable(),
  action_path: z.string().nullable(),
  course_id: z.uuid(),
  course_title: z.string(),
  module_title: z.string(),
  prev_lesson_id: z.uuid().nullable(),
  next_lesson_id: z.uuid().nullable(),
  next_unlocked: z.boolean(),
  progress: z.object({ position_seconds: int, percent: int, completed: z.boolean() }).nullable(),
  materials: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(['file', 'link']),
      title: z.string(),
      storage_path: z.string().nullable(),
      url: z.string().nullable(),
    }),
  ),
});
export type Lesson = z.infer<typeof lessonSchema>;

export const questionSchema = z.object({
  id: z.uuid(),
  author_name: z.string(),
  is_mine: z.boolean(),
  body: z.string(),
  answer: z.string().nullable(),
  answered_at: z.string().nullable(),
  created_at: z.string(),
});
export type Question = z.infer<typeof questionSchema>;

export const certificateSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  holder_name: z.string(),
  course_title: z.string(),
  course_hours: z.coerce.number(),
  issued_at: z.string(),
});
export type Certificate = z.infer<typeof certificateSchema>;

/** Lista plana das aulas na ordem do curso. */
export function flattenLessons(outline: CourseOutline): OutlineLesson[] {
  return outline.modules.flatMap((m) => m.lessons);
}

// ---------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------
const messages: Partial<Record<string, string>> = {
  'academy.not_found': 'Conteúdo não encontrado ou não disponível para a sua conta.',
  'academy.locked': 'Esta aula ainda está bloqueada. Conclua as etapas anteriores.',
  'academy.invalid': 'Dados inválidos. Revise os campos.',
  'academy.forbidden': 'Entre na sua conta para acessar a Academia.',
  'academy.certificate_disabled': 'Este curso não emite certificado.',
  'academy.not_completed': 'Conclua todas as aulas obrigatórias para emitir o certificado.',
  'academy.limit_reached': 'Limite de perguntas por dia atingido. Tente amanhã.',
  'admin.forbidden': 'Acesso restrito à equipe da plataforma.',
};

export function academyErrorMessage(error: unknown): string {
  const { message } = (error ?? {}) as { message?: unknown };
  if (typeof message === 'string' && messages[message]) return messages[message];
  return orgErrorMessage(error);
}
