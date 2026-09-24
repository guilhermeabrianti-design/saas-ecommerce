import { useState } from 'react';
import { Check, Copy, Sparkles } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { useAiUsage } from '@/features/ai/api';
import { cn } from '@/utils/cn';
import { useGenerate, useProductOptions } from '../api';
import { GENERATION_KINDS, MAX_BRIEF, generationLabels, type GenerationKind } from '../tools';

function CopyItem({ text, index }: { text: string; index: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <li className="border-border space-y-2 rounded-xl border p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted text-xs">Opção {index + 1}</span>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setCopied(false);
            }
          }}
          className="text-brand hover:bg-brand/10 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium"
          aria-label={`Copiar opção ${index + 1}`}
        >
          {copied ? (
            <Check className="size-4" aria-hidden />
          ) : (
            <Copy className="size-4" aria-hidden />
          )}
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>
      <p className="text-sm whitespace-pre-wrap">{text}</p>
      {text.length <= 60 && <p className="text-muted text-xs">{text.length} caracteres</p>}
    </li>
  );
}

/** Títulos, copy e roteiros a partir de um produto da organização. Nada é salvo. */
export function AiGenerator({ orgId, canUse }: { orgId: string; canUse: boolean }) {
  const [search, setSearch] = useState('');
  const [productId, setProductId] = useState('');
  const [kind, setKind] = useState<GenerationKind>('title');
  const [brief, setBrief] = useState('');
  const products = useProductOptions(orgId, search);
  const usage = useAiUsage(orgId, canUse);
  const generate = useGenerate(orgId);

  if (!canUse) {
    return (
      <Alert tone="info">
        Os geradores com IA são usados por proprietários e administradores da organização.
      </Alert>
    );
  }

  const quotaLeft = usage.data ? usage.data.daily_limit - usage.data.used : null;

  return (
    <div className="space-y-6">
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (productId) generate.mutate({ productId, kind, brief });
        }}
      >
        <div role="radiogroup" aria-label="O que gerar" className="grid gap-2 sm:grid-cols-2">
          {GENERATION_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => setKind(k)}
              className={cn(
                'border-border rounded-lg border p-3 text-left transition-colors',
                kind === k ? 'border-brand bg-brand/5' : 'hover:bg-surface-2',
              )}
            >
              <span className="block text-sm font-medium">{generationLabels[k].label}</span>
              <span className="text-muted block text-xs">{generationLabels[k].hint}</span>
            </button>
          ))}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Buscar produto"
            placeholder="Nome ou SKU"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select label="Produto" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">{products.isPending ? 'Carregando…' : 'Escolha um produto'}</option>
            {products.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.sku})
              </option>
            ))}
          </Select>
        </div>
        <TextField
          label="Orientação (opcional)"
          placeholder="Ex.: foco em presente de Dia das Mães, público jovem"
          maxLength={MAX_BRIEF}
          hint={`${brief.length}/${MAX_BRIEF} · A IA usa só os dados do cadastro do produto.`}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
        />

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            loading={generate.isPending}
            disabled={!productId || quotaLeft === 0}
          >
            <Sparkles className="size-4" aria-hidden />
            Gerar
          </Button>
          {quotaLeft !== null && (
            <span className="text-muted text-sm">
              {quotaLeft} de {usage.data!.daily_limit} gerações restantes hoje (cota da organização,
              junto com as descrições).
            </span>
          )}
        </div>
      </form>

      {generate.isError && <Alert tone="error">{generate.error.message}</Alert>}
      {generate.isSuccess && (
        <section aria-label="Sugestões geradas" className="space-y-3">
          <Alert tone="info">
            Sugestões da IA: revise antes de usar. Nada foi salvo; copie o que quiser aproveitar.
          </Alert>
          <ol className="space-y-3">
            {generate.data.items.map((text, i) => (
              <CopyItem key={`${i}-${text.slice(0, 20)}`} text={text} index={i} />
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
