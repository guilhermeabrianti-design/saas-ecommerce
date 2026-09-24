import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowDown, ArrowLeft, ArrowUp, Plus } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { TextField } from '@/components/ui/TextField';
import { Pager } from '@/features/admin/components/Pager';
import { cn } from '@/utils/cn';
import { academyErrorMessage, audienceLabels, courseStatusLabels, levelLabels } from '../academy';
import {
  ADMIN_ACADEMY_PAGE,
  useAdminCourses,
  useAdminDeleteQuestion,
  useAdminQuestions,
  useAnswerQuestion,
  useApproveUnlock,
  useCreateCourse,
  useMoveItem,
  useUnlockRequests,
} from '../api';

const when = (iso: string) => new Date(iso).toLocaleString('pt-BR');

const statusTone = {
  draft: 'bg-surface-2 text-muted',
  published: 'bg-success/10 text-success',
  archived: 'bg-danger/10 text-danger',
} as const;

function Courses() {
  const courses = useAdminCourses();
  const create = useCreateCourse();
  const move = useMoveItem();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const valid = title.trim().length >= 3 && title.trim().length <= 120;

  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          create.mutate(
            {
              title: title.trim(),
              description: '',
              level: 'beginner',
              status: 'draft',
              audience: 'all',
              certificate_enabled: false,
            },
            { onSuccess: (id) => void navigate(`/admin/academia/${id}`) },
          );
        }}
      >
        <div className="min-w-56 flex-1">
          <TextField
            label="Novo curso"
            placeholder="Ex.: Venda Sem Estoque"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
          />
        </div>
        <Button type="submit" loading={create.isPending} disabled={!valid}>
          <Plus className="size-4" aria-hidden />
          Criar rascunho
        </Button>
      </form>
      {create.isError && <Alert tone="error">{academyErrorMessage(create.error)}</Alert>}

      {courses.isPending ? (
        <PageLoader />
      ) : courses.isError ? (
        <Alert tone="error">{academyErrorMessage(courses.error)}</Alert>
      ) : courses.data.length === 0 ? (
        <p className="text-muted text-sm">Nenhum curso criado.</p>
      ) : (
        <ul className="divide-border divide-y text-sm">
          {courses.data.map((c, i) => (
            <li key={c.id} className="flex items-center gap-3 py-3">
              <span className="flex flex-col">
                <button
                  type="button"
                  aria-label={`Subir ${c.title}`}
                  disabled={i === 0 || move.isPending}
                  onClick={() => move.mutate({ kind: 'course', id: c.id, direction: -1 })}
                  className="text-muted hover:text-fg disabled:opacity-30"
                >
                  <ArrowUp className="size-4" aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={`Descer ${c.title}`}
                  disabled={i === courses.data.length - 1 || move.isPending}
                  onClick={() => move.mutate({ kind: 'course', id: c.id, direction: 1 })}
                  className="text-muted hover:text-fg disabled:opacity-30"
                >
                  <ArrowDown className="size-4" aria-hidden />
                </button>
              </span>
              <Link to={`/admin/academia/${c.id}`} className="min-w-0 flex-1 hover:underline">
                <span className="font-medium">{c.title}</span>
                <span className="text-muted block text-xs">
                  {levelLabels[c.level]} · para {audienceLabels[c.audience].toLowerCase()}
                  {c.certificate_enabled && ' · com certificado'}
                </span>
              </Link>
              <span
                className={cn('rounded-full px-2 py-0.5 text-xs font-medium', statusTone[c.status])}
              >
                {courseStatusLabels[c.status]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UnlockRequests() {
  const requests = useUnlockRequests();
  const approve = useApproveUnlock();
  if (requests.isPending) return <PageLoader />;
  if (requests.isError) return <Alert tone="error">{academyErrorMessage(requests.error)}</Alert>;
  if (requests.data.length === 0) {
    return <p className="text-muted text-sm">Nenhum pedido de liberação.</p>;
  }
  return (
    <ul className="divide-border divide-y text-sm">
      {requests.data.map((r) => (
        <li key={`${r.user_id}-${r.lesson_id}`} className="flex flex-wrap items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {r.full_name} <span className="text-muted font-normal">· {r.email}</span>
            </p>
            <p className="text-muted text-xs">
              {r.course_title} › {r.lesson_title} · pedido em {when(r.requested_at)}
            </p>
          </div>
          <Button
            loading={
              approve.isPending &&
              approve.variables?.userId === r.user_id &&
              approve.variables.lessonId === r.lesson_id
            }
            onClick={() => approve.mutate({ userId: r.user_id, lessonId: r.lesson_id })}
          >
            Liberar
          </Button>
        </li>
      ))}
      {approve.isError && (
        <li className="text-danger py-2 text-xs">{academyErrorMessage(approve.error)}</li>
      )}
    </ul>
  );
}

function AnswerForm({ id }: { id: string }) {
  const answer = useAnswerQuestion();
  const remove = useAdminDeleteQuestion();
  const [text, setText] = useState('');
  const valid = text.trim().length >= 2 && text.trim().length <= 4000;
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) answer.mutate({ id, answer: text });
      }}
    >
      <textarea
        aria-label="Resposta"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={4000}
        rows={2}
        className="border-border bg-surface focus:border-brand focus:ring-brand/30 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2"
      />
      <div className="flex gap-2">
        <Button type="submit" variant="secondary" loading={answer.isPending} disabled={!valid}>
          Responder
        </Button>
        <Button variant="ghost" loading={remove.isPending} onClick={() => remove.mutate(id)}>
          Excluir pergunta
        </Button>
      </div>
      {(answer.isError || remove.isError) && (
        <p className="text-danger text-xs">{academyErrorMessage(answer.error ?? remove.error)}</p>
      )}
    </form>
  );
}

function Questions() {
  const [openOnly, setOpenOnly] = useState(true);
  const [page, setPage] = useState(1);
  const questions = useAdminQuestions(openOnly, page);

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="accent-brand size-4"
          checked={openOnly}
          onChange={(e) => {
            setOpenOnly(e.target.checked);
            setPage(1);
          }}
        />
        Só sem resposta
      </label>
      {questions.isPending ? (
        <PageLoader />
      ) : questions.isError ? (
        <Alert tone="error">{academyErrorMessage(questions.error)}</Alert>
      ) : questions.data.items.length === 0 ? (
        <p className="text-muted text-sm">
          Nenhuma pergunta{openOnly ? ' aguardando resposta' : ''}.
        </p>
      ) : (
        <ul className="divide-border divide-y text-sm">
          {questions.data.items.map((q) => (
            <li key={q.id} className="space-y-2 py-3">
              <p className="text-muted text-xs">
                {q.course_title} ›{' '}
                <Link to={`/academia/aula/${q.lesson_id}`} className="underline">
                  {q.lesson_title}
                </Link>{' '}
                · {q.author_name ?? 'conta removida'}
                {q.author_email && ` (${q.author_email})`} · {when(q.created_at)}
              </p>
              <p className="whitespace-pre-line">{q.body}</p>
              {q.answer ? (
                <p className="text-muted border-l-2 pl-3 whitespace-pre-line">{q.answer}</p>
              ) : (
                <AnswerForm id={q.id} />
              )}
            </li>
          ))}
        </ul>
      )}
      {questions.data && (
        <Pager
          page={page}
          total={questions.data.total}
          pageSize={ADMIN_ACADEMY_PAGE}
          onPage={setPage}
          noun="perguntas"
        />
      )}
    </div>
  );
}

export function AcademyAdminPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link to="/admin" className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm">
        <ArrowLeft className="size-4" aria-hidden />
        Administração
      </Link>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Academia</h1>
        <p className="text-muted text-sm">
          Cursos, módulos e aulas (vídeos do YouTube), liberações e perguntas dos alunos.
        </p>
      </div>
      <Section
        title="Cursos"
        description="Rascunho não aparece para alunos; Liberado aparece; Bloqueado some do catálogo."
      >
        <Courses />
      </Section>
      <Section title="Pedidos de liberação" description="Aulas que exigem aprovação da equipe.">
        <UnlockRequests />
      </Section>
      <Section title="Perguntas dos alunos" description="Respostas aparecem na aula para todos.">
        <Questions />
      </Section>
    </div>
  );
}
