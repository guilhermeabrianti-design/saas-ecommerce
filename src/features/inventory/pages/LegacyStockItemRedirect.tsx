import { Navigate, useParams } from 'react-router';

/** /estoque/:id (links antigos e notificações de estoque baixo) → item dentro de Produtos. */
export function LegacyStockItemRedirect() {
  const { itemId = '' } = useParams();
  return <Navigate to={`/produtos/estoque/${encodeURIComponent(itemId)}`} replace />;
}
