import { useState } from 'react';
import { Link } from 'react-router';
import { Percent, ShieldCheck } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Pager as BasePager } from '../components/Pager';
import { TextField } from '@/components/ui/TextField';
import { orgKindLabels } from '@/features/organizations/roles';
import { formatBRL } from '@/utils/money';
import {
  ADMIN_PAGE_SIZE,
  adminErrorMessage,
  auditActionLabels,
  useAdminOrganizations,
  useAdminStats,
  useAuditEntries,
  useSetSuspension,
  type AdminOrganization,
} from '../api';

const int = (v: number) => v.toLocaleString('pt-BR');
const when = (iso: string) => new Date(iso).toLocaleString('pt-BR');

const Pager = (props: Omit<Parameters<typeof BasePager>[0], 'pageSize'>) => (
  <BasePager {...props} pageSize={ADMIN_PAGE_SIZE} />
);

function Stats() {
  const stats = useAdminStats();
  if (stats.isPending) return <PageLoader />;
  if (stats.isError) return <Alert tone="error">{adminErrorMessage(stats.error)}</Alert>;
  const s = stats.data;
  const cards = [
    { label: 'Usuários', value: int(s.users) },
    { label: 'Vendedores', value: int(s.sellers) },
    { label: 'Fornecedores', value: int(s.suppliers) },
    { label: 'Suspensas', value: int(s.suspended) },
    { label: 'Pedidos (30 dias)', value: int(s.orders_30d) },
    { label: 'Volume (30 dias)', value: formatBRL(s.gmv_30d_cents) },
    { label: 'Integrações ativas', value: int(s.active_connections) },
  ];
  const pending = s.pending_suppliers + s.pending_listings;
  return (
    <div className="space-y-3">
      <Link
        to="/admin/moderacao"
        className={
          'flex items-center gap-3 rounded-xl border px-4 py-3 text-sm ' +
          (pending > 0
            ? 'border-brand/40 bg-brand/5 hover:bg-brand/10'
            : 'border-border bg-surface hover:bg-surface-2')
        }
      >
        <ShieldCheck className="text-brand size-5" aria-hidden />
        <span>
          <span className="block font-medium">Moderação</span>
          <span className="text-muted">
            {pending === 0
              ? 'Nada aguardando análise.'
              : `${int(s.pending_suppliers)} fornecedor(es) e ${int(s.pending_listings)} anúncio(s) aguardando análise.`}
          </span>
        </span>
      </Link>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="border-border bg-surface rounded-xl border px-4 py-3">
            <dt className="text-muted text-xs">{c.label}</dt>
            <dd className="text-2xl font-semibold tabular-nums">{c.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function SuspensionControl({ org }: { org: AdminOrganization }) {
  const set = useSetSuspension();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const suspended = org.suspended_at !== null;

  const error = set.isError ? (
    <p className="text-danger w-full text-xs">{adminErrorMessage(set.error)}</p>
  ) : null;

  if (suspended) {
    return (
      <>
        <Button
          variant="secondary"
          loading={set.isPending}
          onClick={() => set.mutate({ orgId: org.id, suspended: false, reason: '' })}
        >
          Reativar
        </Button>
        {error}
      </>
    );
  }
  if (!asking) {
    return (
      <Button variant="secondary" onClick={() => setAsking(true)}>
        Suspender
      </Button>
    );
  }
  const valid = reason.trim().length >= 3;
  return (
    <form
      className="flex w-full flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) {
          set.mutate(
            { orgId: org.id, suspended: true, reason },
            {
              onSuccess: () => {
                setAsking(false);
                setReason('');
              },
            },
          );
        }
      }}
    >
      <div className="min-w-48 flex-1">
        <TextField
          label="Motivo da suspensão"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          autoFocus
        />
      </div>
      <Button type="submit" variant="danger" loading={set.isPending} disabled={!valid}>
        Confirmar suspensão
      </Button>
      <Button variant="ghost" onClick={() => setAsking(false)}>
        Cancelar
      </Button>
      {error}
    </form>
  );
}

function Organizations() {
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const orgs = useAdminOrganizations(search, page);

  return (
    <div className="space-y-4">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setSearch(input.trim());
        }}
      >
        <input
          aria-label="Buscar empresa"
          placeholder="Buscar pelo nome"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="border-border bg-surface focus:border-brand focus:ring-brand/30 h-10 min-w-0 flex-1 rounded-lg border px-3 text-sm outline-none focus:ring-2"
        />
        <Button type="submit" variant="secondary">
          Buscar
        </Button>
      </form>

      {orgs.isPending ? (
        <PageLoader />
      ) : orgs.isError ? (
        <Alert tone="error">{adminErrorMessage(orgs.error)}</Alert>
      ) : orgs.data.items.length === 0 ? (
        <p className="text-muted text-sm">Nenhuma empresa encontrada.</p>
      ) : (
        <ul className="divide-border -my-3 divide-y text-sm">
          {orgs.data.items.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {o.name}
                  {o.suspended_at && (
                    <span className="bg-danger/10 text-danger ml-2 rounded-full px-2 py-0.5 text-xs">
                      Suspensa
                    </span>
                  )}
                </p>
                <p className="text-muted text-xs">
                  {orgKindLabels[o.kind]} · {int(o.members)} membro(s) · {int(o.orders)} pedido(s) ·
                  criada em {when(o.created_at)}
                </p>
                {o.suspension_reason && (
                  <p className="text-danger text-xs">Motivo: {o.suspension_reason}</p>
                )}
              </div>
              <SuspensionControl key={`${o.id}-${o.suspended_at}`} org={o} />
            </li>
          ))}
        </ul>
      )}
      {orgs.data && <Pager page={page} total={orgs.data.total} onPage={setPage} noun="empresas" />}
    </div>
  );
}

function Audit() {
  const [page, setPage] = useState(1);
  const audit = useAuditEntries(page);

  if (audit.isPending) return <PageLoader />;
  if (audit.isError) return <Alert tone="error">{adminErrorMessage(audit.error)}</Alert>;
  if (audit.data.items.length === 0) {
    return <p className="text-muted text-sm">Nenhuma ação registrada.</p>;
  }
  return (
    <div className="space-y-4">
      <ul className="divide-border -my-3 divide-y text-sm">
        {audit.data.items.map((a) => (
          <li key={a.id} className="flex flex-wrap items-start gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {auditActionLabels[a.action] ?? a.action}
                {a.organization_name && ` — ${a.organization_name}`}
              </p>
              <p className="text-muted text-xs">
                por {a.admin_name ?? 'conta removida'}
                {a.reason && ` · motivo: ${a.reason}`}
              </p>
            </div>
            <span className="text-muted text-xs">{when(a.created_at)}</span>
          </li>
        ))}
      </ul>
      <Pager page={page} total={audit.data.total} onPage={setPage} noun="registros" />
    </div>
  );
}

export function AdminPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Administração</h1>
        <p className="text-muted text-sm">
          Visão agregada da plataforma. Dados de negócio das organizações (pedidos, clientes,
          financeiro) não são acessíveis por aqui.
        </p>
      </div>
      <Stats />
      <Link
        to="/admin/taxas"
        className="border-border bg-surface hover:bg-surface-2 flex items-center gap-3 rounded-xl border px-4 py-3 text-sm"
      >
        <Percent className="text-brand size-5" aria-hidden />
        <span>
          <span className="block font-medium">Taxas e comissões</span>
          <span className="text-muted">
            Taxas dos marketplaces, comissão do vendedor, categorias e simulador da divisão.
          </span>
        </span>
      </Link>
      <Section
        title="Empresas"
        description="Suspender bloqueia todo o acesso da empresa até a reativação. O motivo aparece para os membros."
      >
        <Organizations />
      </Section>
      <Section title="Auditoria" description="Ações da equipe. O registro não pode ser alterado.">
        <Audit />
      </Section>
    </div>
  );
}
