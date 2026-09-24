import { useState, type ReactNode } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import { cn } from '@/utils/cn';
import type { Material } from '../api';
import { materialKindLabels } from '../sales';

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState('copied');
        } catch {
          setState('failed');
        }
        setTimeout(() => setState('idle'), 2000);
      }}
      className="text-brand hover:bg-brand/10 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium"
      aria-label={`Copiar ${label}`}
    >
      {state === 'copied' ? (
        <Check className="size-4" aria-hidden />
      ) : (
        <Copy className="size-4" aria-hidden />
      )}
      {state === 'copied' ? 'Copiado' : state === 'failed' ? 'Selecione e copie' : 'Copiar'}
    </button>
  );
}

/** Um material: texto com botão de copiar, ou arquivo com prévia e download. */
export function MaterialView({ material, actions }: { material: Material; actions?: ReactNode }) {
  const { kind, title, body, file } = material;
  return (
    <article className="border-border space-y-3 rounded-xl border p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-brand font-mono text-[11px] font-medium tracking-widest uppercase">
            {materialKindLabels[kind]}
          </p>
          <h3 className="truncate text-sm font-semibold">{title}</h3>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {body !== null && <CopyButton text={body} label={title} />}
          {file && (
            <a
              href={file.download}
              className="text-brand hover:bg-brand/10 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium"
              aria-label={`Baixar ${title}`}
            >
              <Download className="size-4" aria-hidden />
              Baixar
            </a>
          )}
          {actions}
        </div>
      </header>

      {body !== null && (
        <p
          className={cn(
            'bg-surface-2 rounded-lg px-3 py-2 text-sm whitespace-pre-wrap',
            kind === 'hashtags' && 'text-brand',
          )}
        >
          {body}
        </p>
      )}
      {file && kind === 'image' && (
        <img
          src={file.view}
          alt={title}
          loading="lazy"
          className="bg-surface-2 max-h-80 w-full rounded-lg object-contain"
        />
      )}
      {file && kind === 'video' && (
        <video
          src={file.view}
          controls
          preload="metadata"
          className="max-h-96 w-full rounded-lg bg-black"
        >
          <track kind="captions" />
        </video>
      )}
      {material.storage_path && !file && (
        <p className="text-muted text-sm">Arquivo indisponível no momento. Recarregue a página.</p>
      )}
    </article>
  );
}
