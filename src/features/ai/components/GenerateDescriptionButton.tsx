import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { AiError, aiErrorMessage, useAiUsage, useGenerateDescription } from '../api';

/**
 * Sugere a descrição com IA a partir dos dados SALVOS do produto (o servidor
 * relê o cadastro). O texto só preenche o campo: nada é salvo até a pessoa revisar.
 */
export function GenerateDescriptionButton({
  orgId,
  productId,
  disabled,
  disabledReason,
  onGenerated,
}: {
  orgId: string;
  productId: string;
  disabled: boolean;
  disabledReason?: string;
  onGenerated: (text: string) => void;
}) {
  const generate = useGenerateDescription(orgId, productId);
  const usage = useAiUsage(orgId, !disabled);
  const left = usage.data ? Math.max(usage.data.daily_limit - usage.data.used, 0) : null;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          loading={generate.isPending}
          disabled={disabled || left === 0}
          onClick={() =>
            generate.mutate(undefined, { onSuccess: (r) => onGenerated(r.description) })
          }
        >
          <Sparkles className="size-4" aria-hidden />
          Sugerir com IA
        </Button>
        {left !== null && (
          <span className="text-muted text-xs">
            {left} sugestão(ões) restante(s) hoje na organização
          </span>
        )}
      </div>
      {disabled && disabledReason && <p className="text-muted text-xs">{disabledReason}</p>}
      {generate.isError && (
        <p role="alert" className="text-danger text-xs">
          {generate.error instanceof AiError ? generate.error.message : aiErrorMessage(undefined)}
        </p>
      )}
      {generate.isSuccess && (
        <p className="text-muted text-xs">
          Sugestão da IA inserida no campo. Revise e salve o produto para aplicar.
        </p>
      )}
    </div>
  );
}
