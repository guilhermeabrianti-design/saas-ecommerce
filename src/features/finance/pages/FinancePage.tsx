import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { useOrganization } from '@/features/organizations/organization-context';
import { orgPermissions } from '@/features/organizations/roles';
import { cn } from '@/utils/cn';
import { formatBRL } from '@/utils/money';
import {
  financeErrorMessage,
  LEDGER_PAGE_SIZE,
  useFinanceSummary,
  useLedger,
  type FinanceSummary,
} from '../api';
import { ledgerKindLabels, periods, type PeriodValue } from '../schemas';

interface Card {
  label: string;
  value: number;
  hint?: string;
  tone?: 'good' | 'bad';
}

function cardsFor(kind: 'seller' | 'supplier', s: FinanceSummary): Card[] {
  if (kind === 'supplier') {
    return [
      { label: 'Recebido de vendedores', value: s.supplier_received_cents },
      {
        label: 'A receber',
        value: s.receivable_cents,
        hint: 'Enviados e ainda não pagos pelo vendedor',
      },
    ];
  }
  return [
    { label: 'Recebido de clientes', value: s.received_cents },
    { label: 'Estornos', value: s.refunded_cents },
    { label: 'Pago a fornecedores', value: s.supplier_paid_cents },
    {
      label: 'A pagar a fornecedores',
      value: s.payable_cents,
      hint: 'Enviados e ainda não pagos',
    },
    {
      label: 'Saldo do período',
      value: s.net_cents,
      hint: 'Recebido − estornos − pago a fornecedores',
      tone: s.net_cents < 0 ? 'bad' : 'good',
    },
  ];
}

function Summary({ kind, period }: { kind: 'seller' | 'supplier'; period: PeriodValue }) {
  const { active } = useOrganization();
  const summary = useFinanceSummary(active!.organization.id, period);

  if (summary.isPending) return <PageLoader />;
  if (summary.isError) return <Alert tone="error">{financeErrorMessage(summary.error)}</Alert>;

  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {cardsFor(kind, summary.data).map((c) => (
        <div key={c.label} className="border-border bg-surface rounded-xl border px-4 py-3">
          <dt className="text-muted text-xs">{c.label}</dt>
          <dd
            className={cn(
              'text-2xl font-semibold tabular-nums',
              c.tone === 'bad' && 'text-danger',
              c.tone === 'good' && 'text-success',
            )}
          >
            {formatBRL(c.value)}
          </dd>
          {c.hint && <p className="text-muted mt-1 text-xs">{c.hint}</p>}
        </div>
      ))}
    </dl>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString('pt-BR');

function Ledger() {
  const { active } = useOrganization();
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get('pagina'));
  const page = Number.isInteger(raw) && raw > 0 ? raw : 1;
  const ledger = useLedger(active!.organization.id, page);
  const total = ledger.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / LEDGER_PAGE_SIZE));
  const go = (p: number) => setParams({ pagina: String(p) });

  if (ledger.isPending) return <PageLoader />;
  if (ledger.isError) return <Alert tone="error">{financeErrorMessage(ledger.error)}</Alert>;
  if (ledger.data.items.length === 0) {
    return <p className="text-muted text-sm">Nenhum lançamento ainda.</p>;
  }

  return (
    <div className="space-y-4">
      <ul className="divide-border -my-3 divide-y text-sm">
        {ledger.data.items.map((e) => (
          <li key={e.id} className="flex flex-wrap items-start gap-3 py-3">
            <span
              className={cn(
                'w-28 shrink-0 text-right font-medium tabular-nums',
                e.amount_cents < 0 ? 'text-danger' : 'text-success',
              )}
            >
              {e.amount_cents < 0 ? '−' : '+'}
              {formatBRL(Math.abs(e.amount_cents))}
            </span>
            <div className="min-w-0 flex-1">
              <p>{ledgerKindLabels[e.kind]}</p>
              {e.description && <p className="text-muted truncate text-xs">{e.description}</p>}
            </div>
            <span className="text-muted text-xs">{when(e.created_at)}</span>
          </li>
        ))}
      </ul>
      {total > LEDGER_PAGE_SIZE && (
        <nav className="flex items-center justify-between gap-3 text-sm" aria-label="Paginação">
          <span className="text-muted">
            Página {page} de {pages} · {total} lançamentos
          </span>
          <span className="flex gap-2">
            <Button
              variant="secondary"
              disabled={page <= 1}
              onClick={() => go(page - 1)}
              aria-label="Página anterior"
            >
              <ChevronLeft className="size-4" aria-hidden />
            </Button>
            <Button
              variant="secondary"
              disabled={page >= pages}
              onClick={() => go(page + 1)}
              aria-label="Próxima página"
            >
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          </span>
        </nav>
      )}
    </div>
  );
}

export function FinancePage() {
  const { active } = useOrganization();
  const [period, setPeriod] = useState<PeriodValue>('30');
  const kind = active!.organization.kind;

  if (!orgPermissions.viewFinance(active!.role)) {
    return (
      <div className="mx-auto max-w-3xl">
        <Alert tone="info">
          Os dados financeiros são visíveis apenas para proprietários e administradores.
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Financeiro</h1>
          <p className="text-muted text-sm">
            Livro-razão imutável: lançamentos nunca são alterados nem apagados.
            {kind === 'seller' && (
              <>
                {' '}
                Registre recebimentos e estornos na página de cada{' '}
                <Link to="/pedidos" className="text-brand underline">
                  pedido
                </Link>
                .
              </>
            )}
          </p>
        </div>
        <div className="w-48">
          <Select
            aria-label="Período do resumo"
            value={period}
            onChange={(e) => setPeriod(e.target.value as PeriodValue)}
          >
            {periods.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <Summary kind={kind} period={period} />

      <Section title="Lançamentos" description="Do mais recente ao mais antigo.">
        <Ledger />
      </Section>
    </div>
  );
}
