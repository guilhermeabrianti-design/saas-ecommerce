import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { formatBRL } from '@/utils/money';
import {
  ADMIN_PAYMENTS_PAGE_SIZE,
  useCheckoutPayments,
  useCheckoutSummary,
  useRefundCheckout,
  type AdminPaymentFilter,
} from '../api';
import { checkoutErrorMessage, checkoutMethodLabels, paymentStatusLabels } from '../checkout';

const money = (cents: number | null) => (cents == null ? '—' : formatBRL(cents));

function Summary() {
  const summary = useCheckoutSummary();
  if (summary.isPending) return <PageLoader />;
  if (summary.isError) return <Alert tone="error">Não foi possível carregar o resumo.</Alert>;
  const s = summary.data;
  const tiles: [string, number][] = [
    ['Vendas aprovadas', s.approved_cents],
    ['Taxas do Mercado Pago', s.fees_cents],
    ['Fornecedores', s.supplier_cents],
    ['Comissões de vendedores', s.commission_cents],
    ['Receita TheSigns', s.platform_cents],
  ];
  return (
    <div className="space-y-3">
      <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map(([label, value]) => (
          <div key={label} className="border-border bg-surface rounded-xl border p-4">
            <dt className="text-muted text-xs">{label}</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">{formatBRL(value)}</dd>
          </div>
        ))}
      </dl>
      {s.needs_refund > 0 && (
        <Alert tone="error">
          {s.needs_refund} pagamento(s) aprovado(s) sem condição de seguir aguardam estorno.
        </Alert>
      )}
    </div>
  );
}

export function CheckoutAdminPage() {
  const [filter, setFilter] = useState<AdminPaymentFilter>('all');
  const [page, setPage] = useState(1);
  const payments = useCheckoutPayments(filter, page);
  const refund = useRefundCheckout();

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Pagamentos do checkout</h1>
        <p className="text-muted text-sm">
          Divisão de cada venda aprovada. Receita = venda − taxa do Mercado Pago − fornecedor −
          comissão; estornos e contestações entram como lançamentos negativos.
        </p>
      </div>

      <Summary />

      <Section title="Pagamentos" description="Mais recentes primeiro.">
        <div className="mb-4">
          <Select
            aria-label="Filtro"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as AdminPaymentFilter);
              setPage(1);
            }}
          >
            <option value="all">Todos</option>
            <option value="approved">Aprovados</option>
            <option value="needs_refund">Aguardando estorno</option>
          </Select>
        </div>
        {refund.isError && (
          <Alert tone="error" className="mb-4">
            {checkoutErrorMessage(refund.error)}
          </Alert>
        )}
        {payments.isPending ? (
          <PageLoader />
        ) : payments.isError ? (
          <Alert tone="error">Não foi possível carregar os pagamentos.</Alert>
        ) : payments.data.length === 0 ? (
          <p className="text-muted text-sm">Nenhum pagamento.</p>
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-border text-muted border-b text-left text-xs">
                <tr>
                  <th scope="col" className="px-5 py-2 font-medium">
                    Pedido
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Situação
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Venda
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Taxa
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Fornecedor
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Comissão
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    TheSigns
                  </th>
                  <th scope="col" className="px-5 py-2">
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {payments.data.map((p) => (
                  <tr key={p.order_id}>
                    <td className="px-5 py-3">
                      <p className="font-medium">
                        #{p.order_number} · {p.store_name}
                      </p>
                      <p className="text-muted text-xs">
                        {p.method ? checkoutMethodLabels[p.method] : '—'} · MP {p.external_id} ·{' '}
                        {new Date(p.created_at).toLocaleDateString('pt-BR')}
                      </p>
                    </td>
                    <td className="px-3 py-3">
                      <p>{paymentStatusLabels[p.status]}</p>
                      {p.needs_refund && (
                        <p className="text-danger text-xs">Estornar: {p.refund_reason}</p>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{money(p.amount_cents)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{money(p.fee_cents)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{money(p.supplier_cents)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {money(p.commission_cents)}
                    </td>
                    <td className="px-3 py-3 text-right font-medium tabular-nums">
                      {p.approved_at ? money(p.platform_cents) : '—'}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {p.refundable && (
                        <ConfirmButton
                          confirmLabel={`Estornar ${formatBRL(p.amount_cents)}`}
                          loading={refund.isPending && refund.variables === p.order_id}
                          onConfirm={() => refund.mutate(p.order_id)}
                        >
                          Estornar
                        </ConfirmButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex justify-between">
          <Button variant="secondary" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
            Anteriores
          </Button>
          <Button
            variant="secondary"
            disabled={(payments.data?.length ?? 0) < ADMIN_PAYMENTS_PAGE_SIZE}
            onClick={() => setPage((p) => p + 1)}
          >
            Próximos
          </Button>
        </div>
      </Section>
    </div>
  );
}
