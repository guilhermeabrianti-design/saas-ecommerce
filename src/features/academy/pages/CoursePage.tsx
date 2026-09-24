import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Award, CheckCircle2, Circle, Lock, PlayCircle } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import {
  academyErrorMessage,
  flattenLessons,
  formatDuration,
  levelLabels,
  unlockRuleLabels,
  type OutlineLesson,
} from '../academy';
import { useClaimCertificate, useCourseOutline, useRequestUnlock } from '../api';
import { ProgressBar } from '../components/ProgressBar';

function LessonRow({ courseId, lesson }: { courseId: string; lesson: OutlineLesson }) {
  const request = useRequestUnlock(courseId);
  const icon = !lesson.unlocked ? (
    <Lock className="text-muted size-4 shrink-0" aria-label="Bloqueada" />
  ) : lesson.completed ? (
    <CheckCircle2 className="text-success size-4 shrink-0" aria-label="Concluída" />
  ) : lesson.percent > 0 ? (
    <PlayCircle className="text-brand size-4 shrink-0" aria-label="Em andamento" />
  ) : (
    <Circle className="text-muted size-4 shrink-0" aria-label="Não iniciada" />
  );

  const meta = (
    <span className="text-muted text-xs">
      {formatDuration(lesson.duration_seconds)}
      {!lesson.is_required && ' · opcional'}
      {!lesson.completed && lesson.percent > 0 && ` · ${lesson.percent}% assistido`}
    </span>
  );

  if (!lesson.unlocked) {
    return (
      <li className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
        {icon}
        <span className="text-muted min-w-0 flex-1">
          {lesson.title}
          <span className="block text-xs">{unlockRuleLabels[lesson.unlock_rule]}</span>
        </span>
        {lesson.unlock_rule === 'admin_approval' &&
          (lesson.unlock_requested ? (
            <span className="text-muted text-xs">Liberação solicitada</span>
          ) : (
            <Button
              variant="secondary"
              className="h-8"
              loading={request.isPending}
              onClick={() => request.mutate(lesson.id)}
            >
              Solicitar liberação
            </Button>
          ))}
        {request.isError && (
          <p className="text-danger w-full text-xs">{academyErrorMessage(request.error)}</p>
        )}
      </li>
    );
  }
  return (
    <li>
      <Link
        to={`/academia/aula/${lesson.id}`}
        className="hover:bg-surface-2 -mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 text-sm"
      >
        {icon}
        <span className="min-w-0 flex-1">{lesson.title}</span>
        {meta}
      </Link>
    </li>
  );
}

export function CoursePage() {
  const { courseId = '' } = useParams();
  const outline = useCourseOutline(courseId);
  const claim = useClaimCertificate(courseId);
  const navigate = useNavigate();
  const o = outline.data;

  if (outline.isPending) return <PageLoader />;
  if (outline.isError || !o) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Link
          to="/academia"
          className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Academia
        </Link>
        <Alert tone="error">{academyErrorMessage(outline.error)}</Alert>
      </div>
    );
  }

  const s = o.summary;
  const lessons = flattenLessons(o);
  const resume = lessons.find((l) => l.id === o.resume_lesson_id);
  const started = lessons.some((l) => l.percent > 0 || l.completed);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link
        to="/academia"
        className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Academia
      </Link>

      <div className="space-y-2">
        <p className="text-muted text-sm">{levelLabels[o.level]}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{o.title}</h1>
        {o.description && <p className="text-muted text-sm whitespace-pre-line">{o.description}</p>}
      </div>

      <div className="border-border bg-surface space-y-4 rounded-xl border p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-3xl font-semibold tabular-nums">{s.percent}%</p>
            <p className="text-muted text-sm">{s.completed ? 'Curso concluído' : 'concluído'}</p>
          </div>
          <dl className="flex gap-6 text-sm">
            <div>
              <dt className="text-muted">Módulos</dt>
              <dd className="font-semibold tabular-nums">
                {s.modules_done}/{s.modules_total}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Aulas</dt>
              <dd className="font-semibold tabular-nums">
                {s.lessons_done}/{s.lessons_total}
              </dd>
            </div>
          </dl>
        </div>
        <ProgressBar percent={s.percent} label="Progresso do curso" />
        <div className="flex flex-wrap gap-2">
          {resume && (
            <Button onClick={() => void navigate(`/academia/aula/${resume.id}`)}>
              <PlayCircle className="size-4" aria-hidden />
              {started ? 'Continuar de onde parou' : 'Começar o curso'}
            </Button>
          )}
          {o.certificate_enabled &&
            (o.certificate_id ? (
              <Button
                variant="secondary"
                onClick={() => void navigate(`/academia/certificado/${o.certificate_id}`)}
              >
                <Award className="size-4" aria-hidden />
                Ver certificado
              </Button>
            ) : s.completed ? (
              <Button
                variant="secondary"
                loading={claim.isPending}
                onClick={() =>
                  claim.mutate(undefined, {
                    onSuccess: (id) => void navigate(`/academia/certificado/${id}`),
                  })
                }
              >
                <Award className="size-4" aria-hidden />
                Emitir certificado
              </Button>
            ) : (
              <span className="text-muted inline-flex items-center gap-1 text-sm">
                <Award className="size-4" aria-hidden />
                Certificado ao concluir as aulas obrigatórias
              </span>
            ))}
        </div>
        {resume && resume.percent > 0 && !resume.completed && (
          <p className="text-muted text-sm">
            Você parou em “{resume.title}” ({resume.percent}% assistido).
          </p>
        )}
        {claim.isError && <Alert tone="error">{academyErrorMessage(claim.error)}</Alert>}
      </div>

      {o.modules.length === 0 ? (
        <Alert tone="info">Este curso ainda não tem aulas.</Alert>
      ) : (
        o.modules.map((m, i) => {
          const done = m.lessons.filter((l) => l.completed).length;
          return (
            <Section
              key={m.id}
              title={`Módulo ${String(i + 1).padStart(2, '0')} · ${m.title}`}
              description={`${done}/${m.lessons.length} aula(s) concluída(s)${m.description ? ` · ${m.description}` : ''}`}
            >
              {m.lessons.length === 0 ? (
                <p className="text-muted text-sm">Sem aulas neste módulo.</p>
              ) : (
                <ul className="-my-2">
                  {m.lessons.map((l) => (
                    <LessonRow key={l.id} courseId={o.id} lesson={l} />
                  ))}
                </ul>
              )}
            </Section>
          );
        })
      )}
    </div>
  );
}
