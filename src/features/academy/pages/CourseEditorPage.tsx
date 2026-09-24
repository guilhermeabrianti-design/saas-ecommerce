import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Eye,
  FileText,
  ImageOff,
  Link2,
  Pencil,
  Plus,
} from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { Pager } from '@/features/admin/components/Pager';
import {
  academyErrorMessage,
  audienceLabels,
  courseAudiences,
  courseLevels,
  courseStatuses,
  courseStatusLabels,
  formatClock,
  formatDuration,
  isKnownAction,
  lessonActions,
  levelLabels,
  parseClock,
  parseYouTubeId,
  unlockRuleLabels,
  unlockRules,
  type CourseAudience,
  type CourseLevel,
  type CourseStatus,
  type UnlockRule,
} from '../academy';
import {
  ADMIN_ACADEMY_PAGE,
  useAddMaterial,
  useAdminCourse,
  useDeleteCourse,
  useDeleteLesson,
  useDeleteMaterial,
  useDeleteModule,
  useIssueCertificate,
  useMoveItem,
  useSaveLesson,
  useSaveModule,
  useStudents,
  useUpdateCourse,
  useUploadCover,
  validateAcademyFile,
  type AdminCourse,
  type AdminLesson,
  type AdminMaterial,
  type AdminModule,
} from '../api';
import { ProgressBar } from '../components/ProgressBar';

const textareaClass =
  'border-border bg-surface focus:border-brand focus:ring-brand/30 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2';

function MoveButtons({
  kind,
  id,
  first,
  last,
  label,
}: {
  kind: 'module' | 'lesson' | 'material';
  id: string;
  first: boolean;
  last: boolean;
  label: string;
}) {
  const move = useMoveItem();
  return (
    <span className="flex">
      <button
        type="button"
        aria-label={`Subir ${label}`}
        disabled={first || move.isPending}
        onClick={() => move.mutate({ kind, id, direction: -1 })}
        className="text-muted hover:text-fg p-1 disabled:opacity-30"
      >
        <ArrowUp className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={`Descer ${label}`}
        disabled={last || move.isPending}
        onClick={() => move.mutate({ kind, id, direction: 1 })}
        className="text-muted hover:text-fg p-1 disabled:opacity-30"
      >
        <ArrowDown className="size-4" aria-hidden />
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------
// Curso
// ---------------------------------------------------------------------
function CourseForm({ course }: { course: AdminCourse & { cover_url: string | null } }) {
  const update = useUpdateCourse(course.id);
  const upload = useUploadCover(course.id, course.cover_path);
  const remove = useDeleteCourse();
  const navigate = useNavigate();
  const [title, setTitle] = useState(course.title);
  const [description, setDescription] = useState(course.description);
  const [level, setLevel] = useState<CourseLevel>(course.level);
  const [status, setStatus] = useState<CourseStatus>(course.status);
  const [audience, setAudience] = useState<CourseAudience>(course.audience);
  const [certificate, setCertificate] = useState(course.certificate_enabled);
  const [fileError, setFileError] = useState<string | null>(null);
  const valid =
    title.trim().length >= 3 && title.trim().length <= 120 && description.length <= 5000;

  return (
    <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
      <div className="space-y-2">
        <div className="border-border bg-surface-2 relative aspect-video overflow-hidden rounded-lg border">
          {course.cover_url ? (
            <img src={course.cover_url} alt="Capa do curso" className="size-full object-cover" />
          ) : (
            <ImageOff className="text-muted absolute inset-0 m-auto size-6" aria-hidden />
          )}
        </div>
        <label className="border-border hover:bg-surface-2 flex h-9 cursor-pointer items-center justify-center rounded-lg border text-sm">
          {upload.isPending ? 'Enviando…' : 'Trocar capa'}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            disabled={upload.isPending}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              const err = validateAcademyFile(file, 'cover');
              setFileError(err);
              if (!err) upload.mutate(file);
            }}
          />
        </label>
        {(fileError || upload.isError) && (
          <p className="text-danger text-xs">{fileError ?? academyErrorMessage(upload.error)}</p>
        )}
      </div>

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) {
            update.mutate({
              title: title.trim(),
              description,
              level,
              status,
              audience,
              certificate_enabled: certificate,
            });
          }
        }}
      >
        {update.isError && <Alert tone="error">{academyErrorMessage(update.error)}</Alert>}
        {update.isSuccess && <Alert tone="success">Curso salvo.</Alert>}
        <TextField
          label="Título"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
        />
        <div className="space-y-1.5">
          <label htmlFor="course-desc" className="block text-sm font-medium">
            Descrição
          </label>
          <textarea
            id="course-desc"
            rows={4}
            maxLength={5000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={textareaClass}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Select
            label="Nível"
            value={level}
            onChange={(e) => setLevel(e.target.value as CourseLevel)}
          >
            {courseLevels.map((l) => (
              <option key={l} value={l}>
                {levelLabels[l]}
              </option>
            ))}
          </Select>
          <Select
            label="Situação"
            value={status}
            onChange={(e) => setStatus(e.target.value as CourseStatus)}
          >
            {courseStatuses.map((s) => (
              <option key={s} value={s}>
                {courseStatusLabels[s]}
              </option>
            ))}
          </Select>
          <Select
            label="Para quem"
            value={audience}
            onChange={(e) => setAudience(e.target.value as CourseAudience)}
          >
            {courseAudiences.map((a) => (
              <option key={a} value={a}>
                {audienceLabels[a]}
              </option>
            ))}
          </Select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-brand size-4"
            checked={certificate}
            onChange={(e) => setCertificate(e.target.checked)}
          />
          Emitir certificado ao concluir
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={update.isPending} disabled={!valid}>
            Salvar curso
          </Button>
          <Link
            to={`/academia/${course.id}`}
            className="border-border bg-surface hover:bg-surface-2 inline-flex h-10 items-center gap-2 rounded-lg border px-4 text-sm"
          >
            <Eye className="size-4" aria-hidden />
            Ver como aluno
          </Link>
          <ConfirmButton
            className="ml-auto"
            confirmLabel="Excluir curso e progresso"
            loading={remove.isPending}
            onConfirm={() =>
              remove.mutate(course.id, { onSuccess: () => void navigate('/admin/academia') })
            }
          >
            Excluir curso
          </ConfirmButton>
        </div>
        {remove.isError && (
          <p className="text-danger text-xs">{academyErrorMessage(remove.error)}</p>
        )}
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------
// Aula
// ---------------------------------------------------------------------
function Materials({ lessonId, materials }: { lessonId: string; materials: AdminMaterial[] }) {
  const add = useAddMaterial();
  const remove = useDeleteMaterial();
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const titleOk = title.trim().length >= 2 && title.trim().length <= 120;
  const urlOk = /^https:\/\/\S+$/.test(url.trim());

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">Materiais</p>
      {materials.length === 0 ? (
        <p className="text-muted text-xs">Nenhum material.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {materials.map((m, i) => (
            <li key={m.id} className="flex items-center gap-2">
              <MoveButtons
                kind="material"
                id={m.id}
                first={i === 0}
                last={i === materials.length - 1}
                label={m.title}
              />
              {m.kind === 'file' ? (
                <FileText className="text-muted size-4" aria-hidden />
              ) : (
                <Link2 className="text-muted size-4" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate">{m.title}</span>
              <Button
                variant="ghost"
                className="h-8"
                loading={remove.isPending && remove.variables?.id === m.id}
                onClick={() => remove.mutate({ id: m.id, storage_path: m.storage_path })}
              >
                Remover
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <TextField
          label="Título do material"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
        />
        <TextField
          label="Link https (ou envie um arquivo)"
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <Button
          variant="secondary"
          disabled={!titleOk || !urlOk || add.isPending}
          onClick={() =>
            add.mutate(
              { lessonId, title, url },
              {
                onSuccess: () => {
                  setTitle('');
                  setUrl('');
                },
              },
            )
          }
        >
          Adicionar link
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          aria-label="Arquivo do material (PDF ou imagem)"
          accept="application/pdf,image/jpeg,image/png,image/webp"
          className="text-sm"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            const err = f ? validateAcademyFile(f, 'material') : null;
            setFileError(err);
            setFile(err ? null : f);
          }}
        />
        <Button
          variant="secondary"
          loading={add.isPending}
          disabled={!titleOk || !file}
          onClick={() =>
            file &&
            add.mutate(
              { lessonId, title, file },
              {
                onSuccess: () => {
                  setTitle('');
                  setFile(null);
                },
              },
            )
          }
        >
          Enviar arquivo
        </Button>
      </div>
      {(fileError || add.isError || remove.isError) && (
        <p className="text-danger text-xs">
          {fileError ?? academyErrorMessage(add.error ?? remove.error)}
        </p>
      )}
    </div>
  );
}

function LessonForm({
  courseId,
  moduleId,
  lesson,
  onDone,
}: {
  courseId: string;
  moduleId: string;
  lesson: AdminLesson | null;
  onDone: () => void;
}) {
  const save = useSaveLesson(courseId);
  const [title, setTitle] = useState(lesson?.title ?? '');
  const [video, setVideo] = useState(
    lesson?.youtube_id ? `https://youtu.be/${lesson.youtube_id}` : '',
  );
  const [duration, setDuration] = useState(lesson ? formatClock(lesson.duration_seconds) : '');
  const [description, setDescription] = useState(lesson?.description ?? '');
  const [required, setRequired] = useState(lesson?.is_required ?? true);
  const [rule, setRule] = useState<UnlockRule>(lesson?.unlock_rule ?? 'none');
  const [actionPath, setActionPath] = useState(lesson?.action_path ?? '');
  const [actionLabel, setActionLabel] = useState(lesson?.action_label ?? '');

  const youtubeId = video.trim() ? parseYouTubeId(video) : null;
  const seconds = duration.trim() ? parseClock(duration) : 0;
  const errors = {
    title: title.trim().length < 3 ? 'De 3 a 120 caracteres.' : undefined,
    video: video.trim() && !youtubeId ? 'Cole o link do vídeo do YouTube.' : undefined,
    duration: seconds === null ? 'Use mm:ss (ex.: 12:30).' : undefined,
    action:
      actionPath && (actionLabel.trim().length < 2 || actionLabel.trim().length > 40)
        ? 'Texto do botão: 2 a 40 caracteres.'
        : undefined,
  };
  const valid = !Object.values(errors).some(Boolean) && description.length <= 5000;

  return (
    <form
      className="border-border bg-surface-2/40 space-y-3 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        save.mutate(
          {
            id: lesson?.id ?? null,
            moduleId,
            values: {
              title: title.trim(),
              description,
              youtube_id: youtubeId,
              duration_seconds: seconds ?? 0,
              is_required: required,
              unlock_rule: rule,
              action_path: actionPath || null,
              action_label: actionPath ? actionLabel.trim() : null,
            },
          },
          { onSuccess: onDone },
        );
      }}
    >
      <p className="text-sm font-medium">{lesson ? 'Editar aula' : 'Nova aula'}</p>
      {save.isError && <Alert tone="error">{academyErrorMessage(save.error)}</Alert>}
      <TextField
        label="Título"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={120}
        error={title ? errors.title : undefined}
      />
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
        <TextField
          label="Vídeo do YouTube (link)"
          placeholder="https://www.youtube.com/watch?v=…"
          value={video}
          onChange={(e) => setVideo(e.target.value)}
          error={errors.video}
          hint={youtubeId ? `Vídeo: ${youtubeId}` : 'Deixe vazio para aula só com texto/materiais.'}
        />
        <TextField
          label="Duração"
          placeholder="12:30"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          error={errors.duration}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`lesson-desc-${lesson?.id ?? 'new'}`} className="block text-sm font-medium">
          Descrição
        </label>
        <textarea
          id={`lesson-desc-${lesson?.id ?? 'new'}`}
          rows={4}
          maxLength={5000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={textareaClass}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="Liberação"
          value={rule}
          onChange={(e) => setRule(e.target.value as UnlockRule)}
        >
          {unlockRules.map((r) => (
            <option key={r} value={r}>
              {unlockRuleLabels[r]}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input
            type="checkbox"
            className="accent-brand size-4"
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
          />
          Obrigatória para concluir o curso
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="Botão de ação (opcional)"
          value={actionPath}
          onChange={(e) => {
            const path = e.target.value;
            setActionPath(path);
            const known = lessonActions.find((a) => a.path === path);
            if (known && !actionLabel) setActionLabel(known.label.toUpperCase());
          }}
        >
          <option value="">Sem botão</option>
          {lessonActions.map((a) => (
            <option key={a.path} value={a.path}>
              {a.label} ({a.path})
            </option>
          ))}
          {actionPath && !isKnownAction(actionPath) && (
            <option value={actionPath}>{actionPath}</option>
          )}
        </Select>
        {actionPath && (
          <TextField
            label="Texto do botão"
            placeholder="CADASTRAR PRODUTO AGORA"
            value={actionLabel}
            onChange={(e) => setActionLabel(e.target.value)}
            maxLength={40}
            error={errors.action}
          />
        )}
      </div>
      <div className="flex gap-2">
        <Button type="submit" loading={save.isPending} disabled={!valid}>
          Salvar aula
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function ModuleBlock({
  courseId,
  module,
  index,
  total,
  lessons,
  materials,
}: {
  courseId: string;
  module: AdminModule;
  index: number;
  total: number;
  lessons: AdminLesson[];
  materials: AdminMaterial[];
}) {
  const saveModule = useSaveModule(courseId);
  const removeModule = useDeleteModule();
  const removeLesson = useDeleteLesson();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(module.title);
  const [editing, setEditing] = useState<string | 'new' | null>(null);

  return (
    <div className="border-border space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <MoveButtons
          kind="module"
          id={module.id}
          first={index === 0}
          last={index === total - 1}
          label={module.title}
        />
        {renaming ? (
          <form
            className="flex min-w-0 flex-1 gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (title.trim().length >= 3) {
                saveModule.mutate(
                  { id: module.id, title, description: module.description },
                  { onSuccess: () => setRenaming(false) },
                );
              }
            }}
          >
            <input
              aria-label="Título do módulo"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              autoFocus
              className="border-border bg-surface h-9 min-w-0 flex-1 rounded-lg border px-2 text-sm"
            />
            <Button type="submit" variant="secondary" loading={saveModule.isPending}>
              Salvar
            </Button>
          </form>
        ) : (
          <p className="min-w-0 flex-1 font-medium">
            Módulo {String(index + 1).padStart(2, '0')} · {module.title}
          </p>
        )}
        {!renaming && (
          <Button
            variant="ghost"
            className="h-8"
            aria-label={`Renomear ${module.title}`}
            onClick={() => setRenaming(true)}
          >
            <Pencil className="size-4" aria-hidden />
          </Button>
        )}
        <ConfirmButton
          confirmLabel="Excluir módulo e aulas"
          loading={removeModule.isPending}
          onConfirm={() => removeModule.mutate(module.id)}
        >
          Excluir
        </ConfirmButton>
      </div>
      {(saveModule.isError || removeModule.isError || removeLesson.isError) && (
        <p className="text-danger text-xs">
          {academyErrorMessage(saveModule.error ?? removeModule.error ?? removeLesson.error)}
        </p>
      )}

      {lessons.length === 0 && editing !== 'new' && (
        <p className="text-muted text-sm">Sem aulas.</p>
      )}
      <ul className="space-y-2">
        {lessons.map((l, i) =>
          editing === l.id ? (
            <li key={l.id} className="space-y-3">
              <LessonForm
                courseId={courseId}
                moduleId={module.id}
                lesson={l}
                onDone={() => setEditing(null)}
              />
              <div className="border-border rounded-lg border p-4">
                <Materials
                  lessonId={l.id}
                  materials={materials.filter((m) => m.lesson_id === l.id)}
                />
              </div>
            </li>
          ) : (
            <li key={l.id} className="flex flex-wrap items-center gap-2 text-sm">
              <MoveButtons
                kind="lesson"
                id={l.id}
                first={i === 0}
                last={i === lessons.length - 1}
                label={l.title}
              />
              <span className="min-w-0 flex-1">
                {l.title}
                <span className="text-muted block text-xs">
                  {l.youtube_id ? 'vídeo' : 'sem vídeo'} · {formatDuration(l.duration_seconds)} ·{' '}
                  {unlockRuleLabels[l.unlock_rule].toLowerCase()}
                  {!l.is_required && ' · opcional'}
                  {l.action_label && ` · botão “${l.action_label}”`} ·{' '}
                  {materials.filter((m) => m.lesson_id === l.id).length} material(is)
                </span>
              </span>
              <Button variant="ghost" className="h-8" onClick={() => setEditing(l.id)}>
                Editar
              </Button>
              <ConfirmButton
                confirmLabel="Excluir aula"
                loading={removeLesson.isPending && removeLesson.variables === l.id}
                onConfirm={() => removeLesson.mutate(l.id)}
              >
                Excluir
              </ConfirmButton>
            </li>
          ),
        )}
      </ul>
      {editing === 'new' ? (
        <LessonForm
          courseId={courseId}
          moduleId={module.id}
          lesson={null}
          onDone={() => setEditing(null)}
        />
      ) : (
        <Button variant="secondary" onClick={() => setEditing('new')}>
          <Plus className="size-4" aria-hidden />
          Nova aula
        </Button>
      )}
    </div>
  );
}

function NewModule({ courseId }: { courseId: string }) {
  const save = useSaveModule(courseId);
  const [title, setTitle] = useState('');
  const valid = title.trim().length >= 3 && title.trim().length <= 120;
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid)
          save.mutate({ id: null, title, description: '' }, { onSuccess: () => setTitle('') });
      }}
    >
      <div className="min-w-56 flex-1">
        <TextField
          label="Novo módulo"
          placeholder="Ex.: Como encontrar produtos"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
        />
      </div>
      <Button type="submit" variant="secondary" loading={save.isPending} disabled={!valid}>
        <Plus className="size-4" aria-hidden />
        Adicionar módulo
      </Button>
      {save.isError && (
        <p className="text-danger w-full text-xs">{academyErrorMessage(save.error)}</p>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------
// Alunos
// ---------------------------------------------------------------------
function Students({ courseId }: { courseId: string }) {
  const [page, setPage] = useState(1);
  const students = useStudents(courseId, page);
  const issue = useIssueCertificate();

  if (students.isPending) return <PageLoader />;
  if (students.isError) return <Alert tone="error">{academyErrorMessage(students.error)}</Alert>;
  if (students.data.items.length === 0) {
    return <p className="text-muted text-sm">Nenhum aluno começou este curso ainda.</p>;
  }
  return (
    <div className="space-y-4">
      <ul className="divide-border divide-y text-sm">
        {students.data.items.map((s) => (
          <li key={s.user_id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0 flex-1 space-y-1">
              <p>
                <span className="font-medium">{s.full_name}</span>{' '}
                <span className="text-muted">· {s.email}</span>
              </p>
              <ProgressBar
                percent={s.percent}
                label={`Progresso de ${s.full_name}`}
                className="max-w-60"
              />
              <p className="text-muted text-xs">
                {s.lessons_done}/{s.lessons_total} aulas · {s.percent}%
                {s.completed && ' · concluído'} · última atividade{' '}
                {new Date(s.last_activity).toLocaleString('pt-BR')}
              </p>
            </div>
            {s.certificate_id ? (
              <Link
                to={`/academia/certificado/${s.certificate_id}`}
                className="text-brand text-xs underline"
              >
                Ver certificado
              </Link>
            ) : (
              <Button
                variant="secondary"
                loading={issue.isPending && issue.variables?.userId === s.user_id}
                onClick={() => issue.mutate({ userId: s.user_id, courseId })}
              >
                Emitir certificado
              </Button>
            )}
          </li>
        ))}
      </ul>
      {issue.isError && <p className="text-danger text-xs">{academyErrorMessage(issue.error)}</p>}
      <Pager
        page={page}
        total={students.data.total}
        pageSize={ADMIN_ACADEMY_PAGE}
        onPage={setPage}
        noun="alunos"
      />
    </div>
  );
}

export function CourseEditorPage() {
  const { courseId = '' } = useParams();
  const data = useAdminCourse(courseId);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link
        to="/admin/academia"
        className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Academia
      </Link>
      {data.isPending ? (
        <PageLoader />
      ) : data.isError ? (
        <Alert tone="error">{academyErrorMessage(data.error)}</Alert>
      ) : (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">{data.data.course.title}</h1>
          <Section title="Curso" description="Dados, capa, situação e certificado.">
            <CourseForm key={data.data.course.updated_at} course={data.data.course} />
          </Section>
          <Section
            title="Módulos e aulas"
            description="Vídeos do YouTube (cole o link). Use as setas para ordenar."
          >
            <div className="space-y-4">
              {data.data.modules.map((m, i) => (
                <ModuleBlock
                  key={m.id}
                  courseId={courseId}
                  module={m}
                  index={i}
                  total={data.data.modules.length}
                  lessons={data.data.lessons.filter((l) => l.module_id === m.id)}
                  materials={data.data.materials}
                />
              ))}
              <NewModule courseId={courseId} />
            </div>
          </Section>
          <Section title="Alunos" description="Quem começou o curso e o progresso de cada um.">
            <Students courseId={courseId} />
          </Section>
        </>
      )}
    </div>
  );
}
