import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { getSupabase } from '@/lib/supabase';
import {
  catalogCourseSchema,
  certificateSchema,
  courseAudiences,
  courseLevels,
  courseStatuses,
  lessonSchema,
  outlineSchema,
  questionSchema,
  unlockRules,
} from './academy';

export const ACADEMY_BUCKET = 'academy';

export const academyKeys = {
  all: ['academy'] as const,
  catalog: ['academy', 'catalog'] as const,
  course: (id: string) => ['academy', 'course', id] as const,
  lesson: (id: string) => ['academy', 'lesson', id] as const,
  questions: (lessonId: string) => ['academy', 'questions', lessonId] as const,
  certificate: (id: string) => ['academy', 'certificate', id] as const,
  admin: ['academy', 'admin'] as const,
  adminCourses: ['academy', 'admin', 'courses'] as const,
  adminCourse: (id: string) => ['academy', 'admin', 'course', id] as const,
  students: (id: string, page: number) => ['academy', 'admin', 'students', id, page] as const,
  unlocks: ['academy', 'admin', 'unlocks'] as const,
  adminQuestions: (openOnly: boolean, page: number) =>
    ['academy', 'admin', 'questions', openOnly, page] as const,
};

async function rpc<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>) {
  const { data, error } = await getSupabase().rpc(name, args);
  if (error) throw error;
  return schema.parse(data);
}

/** URLs assinadas (1 h) de arquivos do bucket da Academia; null quando não há acesso. */
export async function signAcademyPaths(paths: string[]): Promise<(string | null)[]> {
  if (paths.length === 0) return [];
  const { data, error } = await getSupabase()
    .storage.from(ACADEMY_BUCKET)
    .createSignedUrls(paths, 3600);
  if (error) throw error;
  const byPath = new Map(data.map((s) => [s.path, s.signedUrl]));
  return paths.map((p) => byPath.get(p) ?? null);
}

// ---------------------------------------------------------------------
// Aluno
// ---------------------------------------------------------------------
export function useAcademyCatalog() {
  return useQuery({
    queryKey: academyKeys.catalog,
    queryFn: async () => {
      const courses = await rpc('academy_catalog', {}, z.array(catalogCourseSchema));
      const covers = await signAcademyPaths(
        courses.flatMap((c) => (c.cover_path ? [c.cover_path] : [])),
      );
      let i = 0;
      return courses.map((c) => ({ ...c, cover_url: c.cover_path ? (covers[i++] ?? null) : null }));
    },
  });
}

export function useCourseOutline(courseId: string) {
  return useQuery({
    queryKey: academyKeys.course(courseId),
    queryFn: () => rpc('academy_course', { p_course: courseId }, outlineSchema),
  });
}

export function useLesson(lessonId: string) {
  return useQuery({
    queryKey: academyKeys.lesson(lessonId),
    retry: false,
    queryFn: async () => {
      const lesson = await rpc('academy_lesson', { p_lesson: lessonId }, lessonSchema);
      const files = lesson.materials.flatMap((m) => (m.storage_path ? [m.storage_path] : []));
      const urls = await signAcademyPaths(files);
      let i = 0;
      return {
        ...lesson,
        materials: lesson.materials.map((m) => ({
          ...m,
          href: m.kind === 'link' ? m.url : (urls[i++] ?? null),
        })),
      };
    },
  });
}

/** Salva a posição sem recarregar a página; só invalida quando a aula conclui. */
export function useSaveProgress(lessonId: string, courseId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { position: number; duration: number }) =>
      rpc(
        'academy_save_progress',
        {
          p_lesson: lessonId,
          p_position_seconds: Math.max(0, Math.floor(v.position)),
          p_duration_seconds: Math.max(1, Math.floor(v.duration)),
        },
        z.object({ percent: z.number(), completed: z.boolean() }),
      ),
    onSuccess: (result) => {
      if (result.completed) {
        void queryClient.invalidateQueries({ queryKey: academyKeys.lesson(lessonId) });
        if (courseId)
          void queryClient.invalidateQueries({ queryKey: academyKeys.course(courseId) });
        void queryClient.invalidateQueries({ queryKey: academyKeys.catalog });
      }
    },
  });
}

export function useSetCompleted(lessonId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (completed: boolean) => {
      const { error } = await getSupabase().rpc('academy_set_completed', {
        p_lesson: lessonId,
        p_completed: completed,
      });
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: academyKeys.all }),
  });
}

export function useRequestUnlock(courseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (lessonId: string) => {
      const { error } = await getSupabase().rpc('academy_request_unlock', { p_lesson: lessonId });
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: academyKeys.course(courseId) }),
  });
}

export function useClaimCertificate(courseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => rpc('academy_claim_certificate', { p_course: courseId }, z.uuid()),
    onSettled: () => queryClient.invalidateQueries({ queryKey: academyKeys.all }),
  });
}

export function useCertificate(id: string) {
  return useQuery({
    queryKey: academyKeys.certificate(id),
    queryFn: () => rpc('academy_certificate', { p_id: id }, certificateSchema),
  });
}

export function useLessonQuestions(lessonId: string) {
  return useQuery({
    queryKey: academyKeys.questions(lessonId),
    queryFn: () => rpc('academy_lesson_questions', { p_lesson: lessonId }, z.array(questionSchema)),
  });
}

export function useAsk(lessonId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      rpc('academy_ask', { p_lesson: lessonId, p_body: body.trim() }, z.uuid()),
    onSettled: () => queryClient.invalidateQueries({ queryKey: academyKeys.questions(lessonId) }),
  });
}

export function useDeleteQuestion(lessonId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await getSupabase().rpc('academy_delete_question', { p_id: id });
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: academyKeys.questions(lessonId) }),
  });
}

// ---------------------------------------------------------------------
// Equipe: conteúdo (tabelas com policy só para a equipe)
// ---------------------------------------------------------------------
export const adminCourseSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string(),
  level: z.enum(courseLevels),
  status: z.enum(courseStatuses),
  audience: z.enum(courseAudiences),
  cover_path: z.string().nullable(),
  certificate_enabled: z.boolean(),
  position: z.number().int(),
  updated_at: z.string(),
});
export type AdminCourse = z.infer<typeof adminCourseSchema>;

export const adminModuleSchema = z.object({
  id: z.uuid(),
  course_id: z.uuid(),
  title: z.string(),
  description: z.string(),
  position: z.number().int(),
  created_at: z.string(),
});
export type AdminModule = z.infer<typeof adminModuleSchema>;

export const adminLessonSchema = z.object({
  id: z.uuid(),
  course_id: z.uuid(),
  module_id: z.uuid(),
  title: z.string(),
  description: z.string(),
  youtube_id: z.string().nullable(),
  duration_seconds: z.number().int(),
  is_required: z.boolean(),
  unlock_rule: z.enum(unlockRules),
  action_label: z.string().nullable(),
  action_path: z.string().nullable(),
  position: z.number().int(),
  created_at: z.string(),
});
export type AdminLesson = z.infer<typeof adminLessonSchema>;

export const adminMaterialSchema = z.object({
  id: z.uuid(),
  lesson_id: z.uuid(),
  kind: z.enum(['file', 'link']),
  title: z.string(),
  storage_path: z.string().nullable(),
  url: z.string().nullable(),
  position: z.number().int(),
  created_at: z.string(),
});
export type AdminMaterial = z.infer<typeof adminMaterialSchema>;

const byOrder = <T extends { position: number; created_at?: string; id: string }>(a: T, b: T) =>
  a.position - b.position ||
  (a.created_at ?? '').localeCompare(b.created_at ?? '') ||
  a.id.localeCompare(b.id);

export function useAdminCourses() {
  return useQuery({
    queryKey: academyKeys.adminCourses,
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('academy_courses')
        .select(
          'id, title, description, level, status, audience, cover_path, certificate_enabled, position, updated_at',
        )
        .order('position')
        .order('created_at');
      if (error) throw error;
      return z.array(adminCourseSchema).parse(data);
    },
  });
}

export function useAdminCourse(courseId: string) {
  return useQuery({
    queryKey: academyKeys.adminCourse(courseId),
    queryFn: async () => {
      const sb = getSupabase();
      const [course, modules, lessons] = await Promise.all([
        sb
          .from('academy_courses')
          .select(
            'id, title, description, level, status, audience, cover_path, certificate_enabled, position, updated_at',
          )
          .eq('id', courseId)
          .single(),
        sb.from('academy_modules').select('*').eq('course_id', courseId),
        sb.from('academy_lessons').select('*').eq('course_id', courseId),
      ]);
      for (const r of [course, modules, lessons]) if (r.error) throw r.error;
      const lessonRows = z.array(adminLessonSchema).parse(lessons.data).sort(byOrder);
      const materials = lessonRows.length
        ? await sb
            .from('academy_materials')
            .select('*')
            .in(
              'lesson_id',
              lessonRows.map((l) => l.id),
            )
        : { data: [], error: null };
      if (materials.error) throw materials.error;
      const cover = adminCourseSchema.parse(course.data);
      const [coverUrl] = await signAcademyPaths(cover.cover_path ? [cover.cover_path] : []);
      return {
        course: { ...cover, cover_url: coverUrl ?? null },
        modules: z.array(adminModuleSchema).parse(modules.data).sort(byOrder),
        lessons: lessonRows,
        materials: z.array(adminMaterialSchema).parse(materials.data).sort(byOrder),
      };
    },
  });
}

function useAdminMutation<T, R = void>(fn: (v: T) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: academyKeys.all }),
  });
}

/** Garante uma linha afetada (policy negou = nada acontece em silêncio). */
async function one<T>(query: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw error;
  if (!data?.length) throw { message: 'admin.forbidden' };
  return data[0]!;
}

export interface CourseInput {
  title: string;
  description: string;
  level: (typeof courseLevels)[number];
  status: (typeof courseStatuses)[number];
  audience: (typeof courseAudiences)[number];
  certificate_enabled: boolean;
}

export const useCreateCourse = () =>
  useAdminMutation(
    async (v: CourseInput) =>
      (await one(getSupabase().from('academy_courses').insert(v).select('id'))).id as string,
  );

export const useUpdateCourse = (courseId: string) =>
  useAdminMutation(async (v: Partial<CourseInput> & { cover_path?: string | null }) => {
    await one(getSupabase().from('academy_courses').update(v).eq('id', courseId).select('id'));
  });

export const useDeleteCourse = () =>
  useAdminMutation(async (courseId: string) => {
    await one(getSupabase().from('academy_courses').delete().eq('id', courseId).select('id'));
  });

export const useSaveModule = (courseId: string) =>
  useAdminMutation(async (v: { id: string | null; title: string; description: string }) => {
    const table = getSupabase().from('academy_modules');
    const values = { title: v.title.trim(), description: v.description };
    await one(
      v.id
        ? table.update(values).eq('id', v.id).select('id')
        : table.insert({ ...values, course_id: courseId }).select('id'),
    );
  });

export const useDeleteModule = () =>
  useAdminMutation(async (id: string) => {
    await one(getSupabase().from('academy_modules').delete().eq('id', id).select('id'));
  });

export interface LessonInput {
  title: string;
  description: string;
  youtube_id: string | null;
  duration_seconds: number;
  is_required: boolean;
  unlock_rule: (typeof unlockRules)[number];
  action_label: string | null;
  action_path: string | null;
}

export const useSaveLesson = (courseId: string) =>
  useAdminMutation(async (v: { id: string | null; moduleId: string; values: LessonInput }) => {
    const table = getSupabase().from('academy_lessons');
    await one(
      v.id
        ? table.update(v.values).eq('id', v.id).select('id')
        : table.insert({ ...v.values, course_id: courseId, module_id: v.moduleId }).select('id'),
    );
  });

export const useDeleteLesson = () =>
  useAdminMutation(async (id: string) => {
    await one(getSupabase().from('academy_lessons').delete().eq('id', id).select('id'));
  });

export const useMoveItem = () =>
  useAdminMutation(
    async (v: {
      kind: 'course' | 'module' | 'lesson' | 'material';
      id: string;
      direction: -1 | 1;
    }) => {
      const { error } = await getSupabase().rpc('admin_move_academy_item', {
        p_kind: v.kind,
        p_id: v.id,
        p_direction: v.direction,
      });
      if (error) throw error;
    },
  );

const ACCEPTED_FILES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Nome de arquivo seguro para o caminho no bucket (sem barras, até 120 caracteres). */
export function storageFileName(file: File): string {
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  const base = file.name
    .replace(/\.[^.]*$/, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const id = crypto.randomUUID().slice(0, 8);
  return `${id}-${base || 'arquivo'}${ext ? `.${ext.replace(/[^a-z0-9]/g, '').slice(0, 5)}` : ''}`;
}

export function validateAcademyFile(file: File, kind: 'cover' | 'material'): string | null {
  const allowed = kind === 'cover' ? ACCEPTED_FILES.slice(0, 3) : ACCEPTED_FILES;
  if (!allowed.includes(file.type)) {
    return kind === 'cover' ? 'Use JPG, PNG ou WebP.' : 'Use PDF, JPG, PNG ou WebP.';
  }
  if (file.size > MAX_FILE_BYTES) return 'Arquivo acima de 20 MB.';
  return null;
}

async function upload(path: string, file: File) {
  const { error } = await getSupabase()
    .storage.from(ACADEMY_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false, cacheControl: '3600' });
  if (error) throw error;
}

async function removeFile(path: string) {
  // Falha ao remover o arquivo antigo não impede a operação (fica órfão no bucket).
  await getSupabase().storage.from(ACADEMY_BUCKET).remove([path]);
}

export const useUploadCover = (courseId: string, previous: string | null) =>
  useAdminMutation(async (file: File) => {
    const path = `covers/${courseId}/${storageFileName(file)}`;
    await upload(path, file);
    await one(
      getSupabase()
        .from('academy_courses')
        .update({ cover_path: path })
        .eq('id', courseId)
        .select('id'),
    );
    if (previous) await removeFile(previous);
  });

export const useAddMaterial = () =>
  useAdminMutation(
    async (v: { lessonId: string; title: string } & ({ file: File } | { url: string })) => {
      const table = getSupabase().from('academy_materials');
      if ('file' in v) {
        const path = `materials/${v.lessonId}/${storageFileName(v.file)}`;
        await upload(path, v.file);
        try {
          await one(
            table
              .insert({
                lesson_id: v.lessonId,
                kind: 'file',
                title: v.title.trim(),
                storage_path: path,
              })
              .select('id'),
          );
        } catch (e) {
          await removeFile(path);
          throw e;
        }
      } else {
        await one(
          table
            .insert({
              lesson_id: v.lessonId,
              kind: 'link',
              title: v.title.trim(),
              url: v.url.trim(),
            })
            .select('id'),
        );
      }
    },
  );

export const useDeleteMaterial = () =>
  useAdminMutation(async (m: { id: string; storage_path: string | null }) => {
    await one(getSupabase().from('academy_materials').delete().eq('id', m.id).select('id'));
    if (m.storage_path) await removeFile(m.storage_path);
  });

// ---------------------------------------------------------------------
// Equipe: alunos, liberações, certificados e perguntas
// ---------------------------------------------------------------------
export const ADMIN_ACADEMY_PAGE = 20;

const studentSchema = z.object({
  user_id: z.uuid(),
  full_name: z.string(),
  email: z.string(),
  lessons_done: z.coerce.number(),
  lessons_total: z.coerce.number(),
  percent: z.number(),
  completed: z.boolean(),
  last_activity: z.string(),
  certificate_id: z.uuid().nullable(),
  total_count: z.coerce.number(),
});
export type Student = z.infer<typeof studentSchema>;

export function useStudents(courseId: string, page: number) {
  return useQuery({
    queryKey: academyKeys.students(courseId, page),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const items = await rpc(
        'admin_academy_students',
        {
          p_course: courseId,
          p_limit: ADMIN_ACADEMY_PAGE,
          p_offset: (page - 1) * ADMIN_ACADEMY_PAGE,
        },
        z.array(studentSchema),
      );
      return { items, total: items[0]?.total_count ?? 0 };
    },
  });
}

const unlockRequestSchema = z.object({
  user_id: z.uuid(),
  full_name: z.string(),
  email: z.string(),
  lesson_id: z.uuid(),
  lesson_title: z.string(),
  course_title: z.string(),
  requested_at: z.string(),
});

export function useUnlockRequests() {
  return useQuery({
    queryKey: academyKeys.unlocks,
    queryFn: () => rpc('admin_academy_unlock_requests', {}, z.array(unlockRequestSchema)),
  });
}

export const useApproveUnlock = () =>
  useAdminMutation(async (v: { userId: string; lessonId: string }) => {
    const { error } = await getSupabase().rpc('admin_approve_unlock', {
      p_user: v.userId,
      p_lesson: v.lessonId,
    });
    if (error) throw error;
  });

export const useIssueCertificate = () =>
  useAdminMutation(async (v: { userId: string; courseId: string }) => {
    const { error } = await getSupabase().rpc('admin_issue_certificate', {
      p_user: v.userId,
      p_course: v.courseId,
    });
    if (error) throw error;
  });

const adminQuestionSchema = z.object({
  id: z.uuid(),
  author_name: z.string().nullable(),
  author_email: z.string().nullable(),
  lesson_id: z.uuid(),
  lesson_title: z.string(),
  course_title: z.string(),
  body: z.string(),
  answer: z.string().nullable(),
  created_at: z.string(),
  total_count: z.coerce.number(),
});

export function useAdminQuestions(openOnly: boolean, page: number) {
  return useQuery({
    queryKey: academyKeys.adminQuestions(openOnly, page),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const items = await rpc(
        'admin_academy_questions',
        {
          p_open_only: openOnly,
          p_limit: ADMIN_ACADEMY_PAGE,
          p_offset: (page - 1) * ADMIN_ACADEMY_PAGE,
        },
        z.array(adminQuestionSchema),
      );
      return { items, total: items[0]?.total_count ?? 0 };
    },
  });
}

export const useAnswerQuestion = () =>
  useAdminMutation(async (v: { id: string; answer: string }) => {
    const { error } = await getSupabase().rpc('admin_answer_question', {
      p_id: v.id,
      p_answer: v.answer.trim(),
    });
    if (error) throw error;
  });

export const useAdminDeleteQuestion = () =>
  useAdminMutation(async (id: string) => {
    const { error } = await getSupabase().rpc('academy_delete_question', { p_id: id });
    if (error) throw error;
  });
