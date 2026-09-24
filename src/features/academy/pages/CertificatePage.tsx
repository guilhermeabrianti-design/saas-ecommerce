import { Link, useParams } from 'react-router';
import { ArrowLeft, Printer } from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { academyErrorMessage } from '../academy';
import { useCertificate } from '../api';

/** Certificado para imprimir ou salvar em PDF pelo navegador. */
export function CertificatePage() {
  const { certificateId = '' } = useParams();
  const cert = useCertificate(certificateId);

  if (cert.isPending) return <PageLoader />;
  if (cert.isError) return <Alert tone="error">{academyErrorMessage(cert.error)}</Alert>;
  const c = cert.data;
  const date = new Date(c.issued_at).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
  const hours = c.course_hours > 0 ? `${c.course_hours.toLocaleString('pt-BR')} hora(s)` : null;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-center justify-between print:hidden">
        <Link
          to="/academia"
          className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Academia
        </Link>
        <Button variant="secondary" onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden />
          Imprimir / salvar PDF
        </Button>
      </div>

      <article className="border-brand/40 bg-surface relative aspect-[1.414] overflow-hidden rounded-xl border-4 p-10 text-center shadow-sm">
        <div className="flex h-full flex-col items-center justify-center gap-5">
          <Logo />
          <p className="text-muted text-sm tracking-[0.3em] uppercase">Certificado de conclusão</p>
          <p className="text-muted">Certificamos que</p>
          <p className="text-3xl font-semibold">{c.holder_name}</p>
          <p className="text-muted max-w-xl">
            concluiu o curso <strong className="text-fg">{c.course_title}</strong> na Academia
            TheSigns{hours ? `, com carga de ${hours}` : ''}, em {date}.
          </p>
          <p className="text-muted mt-6 font-mono text-xs">Código de verificação: {c.code}</p>
        </div>
      </article>
    </div>
  );
}
