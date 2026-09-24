import { useState } from 'react';
import { Section } from '@/components/ui/Section';
import { useOrganization } from '@/features/organizations/organization-context';
import { useSplitEstimate, type SplitInput } from '../api';
import { SplitInputs, SplitResult } from './SplitCalculator';

/** Calculadora do vendedor no anúncio do catálogo: quanto fica para cada parte. */
export function SellerSplitSection({
  listingId,
  suggestedPriceCents,
}: {
  listingId: string;
  suggestedPriceCents: number | null;
}) {
  const { active } = useOrganization();
  const [input, setInput] = useState<SplitInput | null>(null);
  const estimate = useSplitEstimate(
    input ? { ...input, orgId: active!.organization.id, listingId } : null,
  );

  return (
    <Section
      title="Calculadora de venda"
      description="Antes de publicar: quanto fica com o marketplace, o fornecedor, você e a TheSigns."
    >
      <div className="grid gap-6 md:grid-cols-2">
        <SplitInputs defaultPriceCents={suggestedPriceCents} onChange={setInput} />
        {input ? (
          <SplitResult query={estimate} />
        ) : (
          <p className="text-muted text-sm">Informe o preço de venda para ver a divisão.</p>
        )}
      </div>
    </Section>
  );
}
