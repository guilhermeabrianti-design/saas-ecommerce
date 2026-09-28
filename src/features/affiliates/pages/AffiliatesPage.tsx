import { useState } from 'react';
import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { QrCode as QrIcon } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { CopyField } from '@/components/ui/CopyField';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { useOrganization } from '@/features/organizations/organization-context';
import { orgPermissions } from '@/features/organizations/roles';
import { cn } from '@/utils/cn';
import { formatBRL } from '@/utils/money';
import {
  affiliateErrorMessage,
  conversionRate,
  formatRate,
  isValidCode,
  linkFormSchema,
  linkUrl,
  normalizeCode,
  statsPeriods,
  statsTotals,
  storeUrl,
  type LinkFormValues,
  type StatsRow,
} from '../affiliates';
import {
  useAffiliateStats,
  useCheckoutProducts,
  useCreateAffiliateLink,
  usePublicCode,
  useSetPublicCode,
  useUpdateAffiliateLink,
} from '../api';
import { QrCode } from '../components/QrCode';

const origin = () => window.location.origin;

function StoreCodeForm({ orgId, current }: { orgId: string; current: string }) {
  const save = useSetPublicCode(orgId);
  const [code, setCode] = useState(current);
  const valid = isValidCode(code);
  const changed = normalizeCode(code) !== current;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && changed) save.mutate(normalizeCode(code));
      }}
    >
      {save.isError && <Alert tone="error">{affiliateErrorMessage(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">Endereço atualizado.</Alert>}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <TextField
            label="Endereço da loja"
            value={code}
            autoComplete="off"
            onChange={(e) => setCode(e.target.value)}
            error={code && !valid ? 'De 4 a 32 caracteres: letras, números e hífen' : undefined}
            hint="Também é o seu código de indicação. Trocar invalida os links antigos da loja."
          />
        </div>
        <Button
          type="submit"
          variant="secondary"
          disabled={!valid || !changed}
          loading={save.isPending}
        >
          Salvar endereço
        </Button>
      </div>
    </form>
  );
}

function StoreSection({ orgId, canEditCode }: { orgId: string; canEditCode: boolean }) {
  const code = usePublicCode(orgId);
  if (code.isPending) return <PageLoader />;
  if (code.isError) return <Alert tone="error">{affiliateErrorMessage(code.error)}</Alert>;
  const url = storeUrl(origin(), code.data);
  return (
    <Section
      title="Sua página pública"
      description="Vitrine com os produtos que estão no checkout. Divulgue o link ou o QR Code."
    >
      <div className="space-y-4">
        <CopyField value={url} label="Link da loja" />
        <QrCode value={url} fileName={`loja-${code.data}`} />
        {canEditCode && <StoreCodeForm key={code.data} orgId={orgId} current={code.data} />}
      </div>
    </Section>
  );
}

function Totals({ rows }: { rows: StatsRow[] }) {
  const t = statsTotals(rows);
  const tiles: [string, string][] = [
    ['Cliques', String(t.clicks)],
    ['Visitas', String(t.visits)],
    ['Vendas pagas', `${t.paid_orders} de ${t.orders} pedidos`],
    ['Valor vendido', formatBRL(t.sales_cents)],
    ['Sua comissão', formatBRL(t.commission_cents)],
    ['Conversão', formatRate(t.conversion)],
  ];
  return (
    <dl className="grid gap-3 sm:grid-cols-3">
      {tiles.map(([label, value]) => (
        <div key={label} className="border-border bg-surface rounded-xl border px-4 py-3">
          <dt className="text-muted text-xs">{label}</dt>
          <dd className="text-lg font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function LinkActions({ orgId, row }: { orgId: string; row: StatsRow }) {
  const update = useUpdateAffiliateLink(orgId);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(row.name);
  if (!row.link_id) return null;
  const id = row.link_id;
  return (
    <div className="space-y-2">
      {update.isError && <Alert tone="error">{affiliateErrorMessage(update.error)}</Alert>}
      {renaming ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate(
              { id, name: name.trim(), active: row.is_active },
              { onSuccess: () => setRenaming(false) },
            );
          }}
        >
          <div className="min-w-48 flex-1">
            <TextField
              label="Nome do link"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Button type="submit" variant="secondary" loading={update.isPending}>
            Salvar
          </Button>
          <Button variant="ghost" onClick={() => setRenaming(false)}>
            Cancelar
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => setRenaming(true)}>
            Renomear
          </Button>
          <Button
            variant="ghost"
            loading={update.isPending}
            onClick={() => update.mutate({ id, name: row.name, active: !row.is_active })}
          >
            {row.is_active ? 'Pausar' : 'Reativar'}
          </Button>
        </div>
      )}
    </div>
  );
}

function SourceRow({
  orgId,
  row,
  canManage,
}: {
  orgId: string;
  row: StatsRow;
  canManage: boolean;
}) {
  const [showQr, setShowQr] = useState(false);
  const url =
    row.kind === 'link' && row.code
      ? linkUrl(origin(), row.code)
      : row.kind === 'store' && row.code
        ? storeUrl(origin(), row.code)
        : null;
  const figures: [string, string][] = [
    ['Cliques', row.clicks == null ? '—' : String(row.clicks)],
    ['Visitas', row.visits == null ? '—' : String(row.visits)],
    ['Pagos/pedidos', `${row.paid_orders}/${row.orders}`],
    ['Vendido', formatBRL(row.sales_cents)],
    ['Comissão', formatBRL(row.commission_cents)],
    ['Conversão', formatRate(conversionRate(row.paid_orders, row.visits))],
  ];

  return (
    <li className={cn('space-y-3 px-5 py-4', !row.is_active && 'opacity-70')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">
            {row.name}
            {!row.is_active && (
              <span className="bg-surface-2 text-muted ml-2 rounded px-1.5 py-0.5 text-xs">
                Pausado
              </span>
            )}
          </p>
          <p className="text-muted text-xs">
            {row.kind === 'link'
              ? row.product_id
                ? `Produto: ${row.product_name ?? '—'}`
                : 'Destino: página da loja'
              : row.kind === 'store'
                ? 'Acessos direto na vitrine'
                : 'Compras pelo link do produto (/c/…), sem link ou vitrine'}
          </p>
        </div>
        {url && (
          <Button variant="ghost" onClick={() => setShowQr((v) => !v)} aria-expanded={showQr}>
            <QrIcon className="size-4" aria-hidden />
            QR Code
          </Button>
        )}
      </div>
      {url && row.kind === 'link' && <CopyField value={url} label={`Link ${row.name}`} />}
      {url && showQr && <QrCode value={url} fileName={`link-${row.code}`} />}
      <dl className="grid grid-cols-3 gap-2 text-sm sm:grid-cols-6">
        {figures.map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted text-xs">{label}</dt>
            <dd className="tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {canManage && row.kind === 'link' && <LinkActions orgId={orgId} row={row} />}
    </li>
  );
}

function Performance({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const [days, setDays] = useState<number>(30);
  const stats = useAffiliateStats(orgId, days);

  return (
    <Section
      title="Desempenho"
      description="Cliques e visitas dos seus links e da vitrine, e as vendas do checkout que vieram de cada um."
    >
      <div className="space-y-4">
        <div className="max-w-56">
          <Select
            label="Período"
            value={String(days)}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {statsPeriods.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </div>
        {stats.isPending ? (
          <PageLoader />
        ) : stats.isError ? (
          <Alert tone="error">{affiliateErrorMessage(stats.error)}</Alert>
        ) : (
          <>
            <Totals rows={stats.data} />
            <ul className="border-border divide-border -mx-5 divide-y border-y">
              {stats.data.map((row) => (
                <SourceRow
                  key={row.link_id ?? row.kind}
                  orgId={orgId}
                  row={row}
                  canManage={canManage}
                />
              ))}
            </ul>
            <p className="text-muted text-xs">
              Visitas = navegadores diferentes por dia. A venda conta para o último link acessado
              pelo comprador nos 30 dias anteriores à compra. Vendas pagas não incluem estornos.
            </p>
          </>
        )}
      </div>
    </Section>
  );
}

function NewLinkForm({ orgId }: { orgId: string }) {
  const products = useCheckoutProducts(orgId);
  const create = useCreateAffiliateLink(orgId);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<LinkFormValues>({
    resolver: zodResolver(linkFormSchema),
    defaultValues: { name: '', code: '', target: '' },
  });

  const onSubmit = handleSubmit((v) =>
    create.mutate(
      { name: v.name, code: normalizeCode(v.code), productId: v.target || null },
      { onSuccess: () => reset({ name: '', code: '', target: v.target }) },
    ),
  );

  return (
    <Section
      title="Novo link de divulgação"
      description="Um link para cada lugar onde você divulga (bio, stories, grupo, live) mostra o que mais vende."
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {create.isError && <Alert tone="error">{affiliateErrorMessage(create.error)}</Alert>}
        {create.isSuccess && (
          <Alert tone="success">Link criado. Ele já aparece no desempenho.</Alert>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField
            label="Nome"
            placeholder="Ex.: Bio do Instagram"
            error={errors.name?.message}
            {...register('name')}
          />
          <TextField
            label="Código (opcional)"
            placeholder="Gerado se vazio"
            autoComplete="off"
            error={errors.code?.message}
            {...register('code')}
          />
          <Select label="Destino" {...register('target')}>
            <option value="">Página da loja</option>
            {(products.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
        {products.data?.length === 0 && (
          <p className="text-muted text-sm">
            Nenhum produto no checkout ainda. Ligue o checkout num produto importado em{' '}
            <Link to="/produtos" className="text-brand hover:underline">
              Produtos
            </Link>{' '}
            para usar como destino.
          </p>
        )}
        <Button type="submit" loading={create.isPending}>
          Criar link
        </Button>
      </form>
    </Section>
  );
}

export function AffiliatesPage() {
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const role = active!.role;
  const canManage = orgPermissions.editCatalog(role);

  if (!orgPermissions.viewFinance(role)) {
    return (
      <div className="mx-auto max-w-3xl">
        <Alert tone="info">
          Links e desempenho são visíveis apenas para proprietários e administradores.
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Links e divulgação</h1>
        <p className="text-muted text-sm">
          Divulgue sua loja e seus produtos com links rastreáveis e QR Code, e veja quais canais
          trazem vendas pelo checkout.
        </p>
      </div>
      <StoreSection orgId={orgId} canEditCode={role === 'owner'} />
      {canManage && <NewLinkForm orgId={orgId} />}
      <Performance orgId={orgId} canManage={canManage} />
    </div>
  );
}
