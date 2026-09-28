import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from './Button';

/** Campo somente leitura com botão de copiar (o texto continua selecionável sem permissão de área de transferência). */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <input
        readOnly
        value={value}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        className="border-border bg-surface-2 h-10 min-w-0 flex-1 rounded-lg border px-3 font-mono text-xs"
      />
      <Button
        variant="secondary"
        aria-label={`Copiar ${label.toLowerCase()}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            // Sem permissão de área de transferência: o campo continua selecionável.
          }
        }}
      >
        {copied ? (
          <Check className="size-4" aria-hidden />
        ) : (
          <Copy className="size-4" aria-hidden />
        )}
      </Button>
    </div>
  );
}
