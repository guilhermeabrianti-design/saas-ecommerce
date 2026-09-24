import { Link } from 'react-router';
import { Award, GraduationCap, ImageOff } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { academyErrorMessage, formatDuration, levelLabels } from '../academy';
import { useAcademyCatalog } from '../api';
import { ProgressBar } from '../components/ProgressBar';

export function AcademyPage() {
  const catalog = useAcademyCatalog();

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <GraduationCap className="text-brand size-6" aria-hidden />
          Academia
        </h1>
        <p className="text-muted text-sm">
          Aprenda a vender sem estoque, do primeiro produto às estratégias de escala — e aplique
          cada aula direto na plataforma.
        </p>
      </div>

      {catalog.isPending ? (
        <PageLoader />
      ) : catalog.isError ? (
        <Alert tone="error">{academyErrorMessage(catalog.error)}</Alert>
      ) : catalog.data.length === 0 ? (
        <Alert tone="info">Nenhum curso disponível ainda. Novos cursos aparecem aqui.</Alert>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {catalog.data.map((c) => (
            <li key={c.id}>
              <Link
                to={`/academia/${c.id}`}
                className="border-border bg-surface hover:border-brand/50 flex h-full flex-col overflow-hidden rounded-xl border transition-colors"
              >
                <div className="bg-surface-2 relative aspect-video">
                  {c.cover_url ? (
                    <img
                      src={c.cover_url}
                      alt=""
                      className="size-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <ImageOff className="text-muted absolute inset-0 m-auto size-8" aria-hidden />
                  )}
                  {c.completed && (
                    <span className="bg-success absolute top-2 left-2 rounded-full px-2 py-0.5 text-xs font-medium text-white">
                      Curso concluído
                    </span>
                  )}
                </div>
                <div className="flex flex-1 flex-col gap-2 p-4">
                  <p className="text-muted text-xs">
                    {levelLabels[c.level]} · {c.modules} módulo(s) · {c.lessons} aula(s) ·{' '}
                    {formatDuration(c.duration_seconds)}
                  </p>
                  <h2 className="font-semibold">{c.title}</h2>
                  <p className="text-muted line-clamp-2 text-sm">{c.description}</p>
                  <div className="mt-auto space-y-1 pt-2">
                    <ProgressBar percent={c.percent} label={`Progresso em ${c.title}`} />
                    <p className="text-muted flex justify-between text-xs">
                      <span>{c.percent}% concluído</span>
                      {c.certificate_enabled && (
                        <span className="inline-flex items-center gap-1">
                          <Award className="size-3.5" aria-hidden />
                          {c.certificate_id ? 'Certificado emitido' : 'Com certificado'}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
