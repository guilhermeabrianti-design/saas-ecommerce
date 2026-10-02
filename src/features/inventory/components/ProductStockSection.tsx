import { Link } from 'react-router';
import { AlertTriangle } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { describeAttributes } from '@/features/products/variants';
import { cn } from '@/utils/cn';
import { useProductStock } from '../api';
import { inventoryErrorMessage } from '../errors';

const quantity = (n: number) => n.toLocaleString('pt-BR');

/**
 * Estoque do produto (antes era a tela "Estoque"): saldo de cada unidade
 * vendável — o produto ou cada variação — com atalho para movimentar,
 * definir o alerta de estoque baixo e ver o histórico.
 */
export function ProductStockSection({
  orgId,
  productId,
  dropship,
}: {
  orgId: string;
  productId: string;
  dropship: boolean;
}) {
  const levels = useProductStock(orgId, productId);

  return (
    <Section
      title="Estoque"
      description="Saldo por unidade vendável. Toda alteração fica registrada no histórico."
    >
      {dropship && (
        <Alert tone="info" className="mb-4">
          Produto importado do catálogo: as vendas usam o estoque do fornecedor. O saldo abaixo é só
          o seu, caso você tenha unidades próprias.
        </Alert>
      )}
      {levels.isPending ? (
        <PageLoader />
      ) : levels.isError ? (
        <Alert tone="error">{inventoryErrorMessage(levels.error)}</Alert>
      ) : levels.data.length === 0 ? (
        <p className="text-muted text-sm">Nenhum item de estoque.</p>
      ) : (
        <ul className="divide-border -mx-5 divide-y">
          {levels.data.map((l) => (
            <li key={l.id} className={cn('px-5 py-3', !l.is_active && 'opacity-60')}>
              <Link
                to={`/produtos/estoque/${l.id}`}
                className="hover:bg-surface-2 -mx-2 flex items-center gap-3 rounded-lg px-2 py-1 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {l.attributes ? describeAttributes(l.attributes) : 'Produto'}
                    {!l.is_active && ' (variação inativa)'}
                  </p>
                  <p className="text-muted truncate font-mono text-xs">{l.sku}</p>
                </div>
                <div className="text-muted hidden text-right text-xs sm:block">
                  <p>Físico {quantity(l.on_hand)}</p>
                  <p>Reservado {quantity(l.reserved)}</p>
                </div>
                <div className="w-24 text-right">
                  <p className="text-muted text-xs">Disponível</p>
                  <p className={cn('font-semibold tabular-nums', l.is_low && 'text-danger')}>
                    {l.is_low && (
                      <AlertTriangle
                        className="mr-1 inline size-4 align-[-3px]"
                        aria-label="Estoque baixo"
                      />
                    )}
                    {quantity(l.available)}
                  </p>
                </div>
                <span className="text-brand text-xs font-medium">Movimentar</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
