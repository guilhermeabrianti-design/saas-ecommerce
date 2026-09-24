import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Circle,
  ExternalLink,
  FileText,
  Link2,
  Lock,
  PlayCircle,
  Rocket,
  Trash2,
} from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { cn } from '@/utils/cn';
import { academyErrorMessage, formatClock, formatDuration } from '../academy';
import {
  useAsk,
  useCourseOutline,
  useDeleteQuestion,
  useLesson,
  useLessonQuestions,
  useSaveProgress,
  useSetCompleted,
} from '../api';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { YouTubePlayer } from '../components/YouTubePlayer';

function Questions({ lessonId }: { lessonId: string }) {
  const questions = useLessonQuestions(lessonId);
  const ask = useAsk(lessonId);
  const remove = useDeleteQuestion(lessonId);
  const [body, setBody] = useState('');
  const valid = body.trim().length >= 3 && body.trim().length <= 2000;

  return (
    <div className="space-y-4">
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) ask.mutate(body, { onSuccess: () => setBody('') });
        }}
      >
        <label htmlFor="question" className="block text-sm font-medium">
          Sua dúvida sobre esta aula
        </label>
        <textarea
          id="question"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={2000}
          rows={3}
          className="border-border bg-surface focus:border-brand focus:ring-brand/30 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2"
        />
        {ask.isError && <p className="text-danger text-xs">{academyErrorMessage(ask.error)}</p>}
        <Button type="submit" variant="secondary" loading={ask.isPending} disabled={!valid}>
          Enviar pergunta
        </Button>
      </form>

      {questions.isPending ? (
        <PageLoader />
      ) : questions.isError ? (
        <Alert tone="error">{academyErrorMessage(questions.error)}</Alert>
      ) : questions.data.length === 0 ? (
        <p className="text-muted text-sm">Nenhuma pergunta ainda. Seja o primeiro a perguntar.</p>
      ) : (
        <ul className="divide-border divide-y text-sm">
          {questions.data.map((q) => (
            <li key={q.id} className="space-y-2 py-3">
              <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 whitespace-pre-line">
                  <span className="font-medium">{q.is_mine ? 'Você' : q.author_name}: </span>
                  {q.body}
                </p>
                {q.is_mine && (
                  <Button
                    variant="ghost"
                    className="h-8"
                    aria-label="Excluir minha pergunta"
                    loading={remove.isPending && remove.variables === q.id}
                    onClick={() => remove.mutate(q.id)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                )}
              </div>
              {q.answer ? (
                <p className="border-brand/40 bg-brand/5 rounded-lg border-l-2 px-3 py-2 whitespace-pre-line">
                  <span className="font-medium">Equipe TheSigns: </span>
                  {q.answer}
                </p>
              ) : (
                <p className="text-muted text-xs">Aguardando resposta da equipe.</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CourseSidebar({ courseId, currentId }: { courseId: string; currentId: string }) {
  const outline = useCourseOutline(courseId);
  if (!outline.data) return null;
  const s = outline.data.summary;
  return (
    <aside className="border-border bg-surface space-y-3 rounded-xl border p-4 lg:sticky lg:top-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{outline.data.title}</p>
        <ProgressBar percent={s.percent} label="Progresso do curso" />
        <p className="text-muted text-xs">
          {s.percent}% · {s.lessons_done}/{s.lessons_total} aulas
        </p>
      </div>
      <nav aria-label="Aulas do curso" className="max-h-[60vh] space-y-3 overflow-y-auto">
        {outline.data.modules.map((m) => (
          <div key={m.id}>
            <p className="text-muted mb-1 text-xs font-medium">{m.title}</p>
            <ul className="space-y-0.5">
              {m.lessons.map((l) => {
                const Icon = !l.unlocked
                  ? Lock
                  : l.completed
                    ? CheckCircle2
                    : l.percent > 0
                      ? PlayCircle
                      : Circle;
                const content = (
                  <>
                    <Icon
                      className={cn(
                        'size-3.5 shrink-0',
                        l.completed ? 'text-success' : l.unlocked ? 'text-brand' : 'text-muted',
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate">{l.title}</span>
                  </>
                );
                return (
                  <li key={l.id}>
                    {l.unlocked ? (
                      <Link
                        to={`/academia/aula/${l.id}`}
                        aria-current={l.id === currentId ? 'page' : undefined}
                        className={cn(
                          'flex items-center gap-2 rounded-md px-2 py-1 text-sm',
                          l.id === currentId ? 'bg-brand/10 font-medium' : 'hover:bg-surface-2',
                        )}
                      >
                        {content}
                      </Link>
                    ) : (
                      <span className="text-muted flex items-center gap-2 px-2 py-1 text-sm">
                        {content}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}

export function LessonPage() {
  const { lessonId = '' } = useParams();
  const lesson = useLesson(lessonId);
  const l = lesson.data;
  const save = useSaveProgress(lessonId, l?.course_id);
  const setCompleted = useSetCompleted(lessonId);
  const [tab, setTab] = useState<'about' | 'materials' | 'questions'>('about');

  const { mutate: saveProgress } = save;
  const onProgress = useCallback(
    (position: number, duration: number) => saveProgress({ position, duration }),
    [saveProgress],
  );

  if (lesson.isPending) return <PageLoader />;
  if (lesson.isError || !l) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Link
          to="/academia"
          className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Academia
        </Link>
        <Alert tone="error">{academyErrorMessage(lesson.error)}</Alert>
      </div>
    );
  }

  const progress = l.progress;
  const completed = progress?.completed ?? false;
  // Retoma de onde parou, a não ser que já estivesse no fim.
  const start =
    progress && progress.percent < 95 && progress.position_seconds > 5
      ? progress.position_seconds
      : 0;

  return (
    <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[1fr_18rem]">
      <div className="min-w-0 space-y-5">
        <Link
          to={`/academia/${l.course_id}`}
          className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {l.course_title}
        </Link>

        {l.youtube_id ? (
          <YouTubePlayer
            key={l.id}
            videoId={l.youtube_id}
            startSeconds={start}
            onProgress={onProgress}
          />
        ) : (
          <Alert tone="info">Esta aula não tem vídeo: leia o conteúdo e os materiais abaixo.</Alert>
        )}
        {start > 0 && (
          <p className="text-muted text-sm">
            Continuando de onde você parou ({formatClock(start)}).
          </p>
        )}

        <div className="space-y-1">
          <p className="text-muted text-sm">
            {l.module_title} · {formatDuration(l.duration_seconds)}
            {!l.is_required && ' · opcional'}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{l.title}</h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={completed ? 'secondary' : 'primary'}
            loading={setCompleted.isPending}
            onClick={() => setCompleted.mutate(!completed)}
          >
            <CheckCircle2 className="size-4" aria-hidden />
            {completed ? 'Concluída — desmarcar' : 'Marcar como concluída'}
          </Button>
          {l.action_label && l.action_path && (
            <Link
              to={l.action_path}
              className="bg-success inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium text-white hover:opacity-90"
            >
              <Rocket className="size-4" aria-hidden />
              {l.action_label}
            </Link>
          )}
          <span className="ml-auto flex gap-2">
            {l.prev_lesson_id && (
              <Link
                to={`/academia/aula/${l.prev_lesson_id}`}
                className="border-border bg-surface hover:bg-surface-2 inline-flex h-10 items-center gap-1 rounded-lg border px-3 text-sm"
              >
                <ArrowLeft className="size-4" aria-hidden />
                Anterior
              </Link>
            )}
            {l.next_lesson_id &&
              (l.next_unlocked ? (
                <Link
                  to={`/academia/aula/${l.next_lesson_id}`}
                  className="border-border bg-surface hover:bg-surface-2 inline-flex h-10 items-center gap-1 rounded-lg border px-3 text-sm"
                >
                  Próxima
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
              ) : (
                <span
                  className="text-muted inline-flex h-10 items-center gap-1 px-3 text-sm"
                  title="Conclua esta aula para liberar a próxima"
                >
                  <Lock className="size-4" aria-hidden />
                  Próxima
                </span>
              ))}
          </span>
        </div>
        {(setCompleted.isError || save.isError) && (
          <Alert tone="error">
            {academyErrorMessage(setCompleted.error ?? save.error)}
            {save.isError && ' (seu progresso pode não ter sido salvo)'}
          </Alert>
        )}

        <div className="flex gap-1 border-b" role="tablist" aria-label="Conteúdo da aula">
          {(
            [
              ['about', 'Descrição'],
              ['materials', `Materiais (${l.materials.length})`],
              ['questions', 'Perguntas'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm',
                tab === key
                  ? 'border-brand font-medium'
                  : 'text-muted hover:text-fg border-transparent',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'about' &&
          (l.description ? (
            <p className="text-sm whitespace-pre-line">{l.description}</p>
          ) : (
            <p className="text-muted text-sm">Sem descrição.</p>
          ))}
        {tab === 'materials' &&
          (l.materials.length === 0 ? (
            <p className="text-muted text-sm">Esta aula não tem materiais complementares.</p>
          ) : (
            <ul className="space-y-2">
              {l.materials.map((m) => (
                <li key={m.id}>
                  {m.href ? (
                    <a
                      href={m.href}
                      target="_blank"
                      rel="noreferrer"
                      className="border-border hover:bg-surface-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                    >
                      {m.kind === 'file' ? (
                        <FileText className="text-brand size-4" aria-hidden />
                      ) : (
                        <Link2 className="text-brand size-4" aria-hidden />
                      )}
                      <span className="flex-1">{m.title}</span>
                      <ExternalLink className="text-muted size-3.5" aria-hidden />
                    </a>
                  ) : (
                    <p className="text-muted text-sm">{m.title} (indisponível no momento)</p>
                  )}
                </li>
              ))}
            </ul>
          ))}
        {tab === 'questions' && (
          <Section title="Perguntas" description="Dúvidas desta aula, respondidas pela equipe.">
            <Questions lessonId={l.id} />
          </Section>
        )}
      </div>

      <CourseSidebar courseId={l.course_id} currentId={l.id} />
    </div>
  );
}
