import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { useOrganization } from '@/features/organizations/organization-context';
import { orgPermissions } from '@/features/organizations/roles';
import { describeAttributes } from '@/features/products/variants';
import {
  useInventoryItem,
  useInventoryMovements,
  useSetMinQuantity,
  useStockMovement,
  type InventoryLevel,
} from '../api';
import { inventoryErrorMessage } from '../errors';
import {
  previewOnHand,
  reasonLabels,
  stockFormSchema,
  stockModeHints,
  stockModes,
  toStockRequest,
  type StockFormValues,
} from '../schemas';

const quantity = (n: number) => n.toLocaleString('pt-BR');
const newRequestId = () => crypto.randomUUID();

function Totals({ item }: { item: InventoryLevel }) {
  const cells = [
    { label: 'Físico', value: item.on_hand },
    { label: 'Reservado', value: item.reserved },
    { label: 'Disponível', value: item.available, highlight: true },
  ];
  return (
    <dl className="grid grid-cols-3 gap-3">
      {cells.map((c) => (
        <div key={c.label} className="border-border bg-surface rounded-xl border px-4 py-3">
          <dt className="text-muted text-xs">{c.label}</dt>
          <dd
            className={
              c.highlight && item.is_low
                ? 'text-danger text-2xl font-semibold tabular-nums'
                : 'text-2xl font-semibold tabular-nums'
            }
          >
            {quantity(c.value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function MovementForm({ item }: { item: InventoryLevel }) {
  const { active } = useOrganization();
  const move = useStockMovement(active!.organization.id, item.id);
  // Kept across retries of the same submission; renewed only after success,
  // so a double click or a retry after a network error never moves stock twice.
  const [requestId, setRequestId] = useState(newRequestId);
  const [done, setDone] = useState<number | null>(null);

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors },
  } = useForm<StockFormValues>({
    resolver: zodResolver(stockFormSchema),
    defaultValues: { mode: 'purchase', quantity: '', note: '' },
  });
  const values = useWatch({ control }) as StockFormValues;
  const preview = previewOnHand(item.on_hand, values);

  const onSubmit = handleSubmit((v) => {
    setDone(null);
    move.mutate(
      { request: toStockRequest(v), requestId },
      {
        onSuccess: (onHand) => {
          setDone(onHand);
          setRequestId(newRequestId());
          reset({ mode: v.mode, quantity: '', note: '' });
        },
      },
    );
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {move.isError && <Alert tone="error">{inventoryErrorMessage(move.error)}</Alert>}
      {done !== null && !move.isPending && (
        <Alert tone="success">Movimentação registrada. Saldo físico: {quantity(done)}.</Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="Tipo" {...register('mode')}>
          {stockModes.map((m) => (
            <option key={m} value={m}>
              {reasonLabels[m]}
            </option>
          ))}
        </Select>
        <TextField
          label="Quantidade"
          inputMode="numeric"
          autoComplete="off"
          hint={stockModeHints[values.mode ?? 'purchase']}
          error={errors.quantity?.message}
          {...register('quantity')}
        />
      </div>
      <TextField
        label="Observação (opcional)"
        placeholder="Ex.: NF 1234, fornecedor X"
        error={errors.note?.message}
        {...register('note')}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={move.isPending}>
          Registrar
        </Button>
        {preview !== null && (
          <span className={preview < item.reserved ? 'text-danger text-sm' : 'text-muted text-sm'}>
            Saldo físico após: {quantity(preview)}
          </span>
        )}
      </div>
    </form>
  );
}

function MinQuantityForm({ item }: { item: InventoryLevel }) {
  const { active } = useOrganization();
  const save = useSetMinQuantity(active!.organization.id, item.id);
  const [value, setValue] = useState(item.min_quantity == null ? '' : String(item.min_quantity));
  const valid = value.trim() === '' || /^\d{1,9}$/.test(value.trim());

  return (
    <form
      noValidate
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate(value.trim() === '' ? null : Number(value));
      }}
    >
      <div className="w-40">
        <TextField
          label="Estoque mínimo"
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          error={valid ? undefined : 'Inteiro ≥ 0'}
        />
      </div>
      <Button type="submit" variant="secondary" loading={save.isPending} disabled={!valid}>
        Salvar
      </Button>
      {save.isError && (
        <p className="text-danger w-full text-sm">{inventoryErrorMessage(save.error)}</p>
      )}
      {save.isSuccess && <p className="text-muted w-full text-sm">Mínimo atualizado.</p>}
    </form>
  );
}

function History({ itemId }: { itemId: string }) {
  const { active } = useOrganization();
  const movements = useInventoryMovements(active!.organization.id, itemId);

  if (movements.isPending) return <PageLoader />;
  if (movements.isError) {
    return <Alert tone="error">{inventoryErrorMessage(movements.error)}</Alert>;
  }
  if (movements.data.length === 0) {
    return <p className="text-muted text-sm">Nenhuma movimentação ainda.</p>;
  }
  return (
    <ul className="divide-border -my-3 divide-y">
      {movements.data.map((m) => (
        <li key={m.id} className="flex items-start gap-3 py-3 text-sm">
          <span
            className={
              m.quantity_delta > 0
                ? 'text-success w-16 shrink-0 text-right font-medium tabular-nums'
                : 'text-danger w-16 shrink-0 text-right font-medium tabular-nums'
            }
          >
            {m.quantity_delta > 0 ? '+' : ''}
            {quantity(m.quantity_delta)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">{reasonLabels[m.reason]}</p>
            {m.note && <p className="text-muted truncate">{m.note}</p>}
          </div>
          <div className="text-muted shrink-0 text-right text-xs">
            <p>{new Date(m.created_at).toLocaleString('pt-BR')}</p>
            <p>saldo {quantity(m.on_hand_after)}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function InventoryItemPage() {
  const { itemId = '' } = useParams();
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const canEdit = orgPermissions.editCatalog(active!.role);
  const item = useInventoryItem(orgId, itemId);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          to={item.data ? `/produtos/${item.data.product_id}` : '/produtos'}
          className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {item.data ? 'Voltar ao produto' : 'Produtos'}
        </Link>
        {item.data && (
          <>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">{item.data.product_name}</h1>
            <p className="text-muted mt-1 text-sm">
              <span className="font-mono">{item.data.sku}</span>
              {item.data.attributes && ` · ${describeAttributes(item.data.attributes)}`}
            </p>
          </>
        )}
      </div>

      {item.isPending ? (
        <PageLoader />
      ) : item.isError ? (
        <Alert tone="error">{inventoryErrorMessage(item.error)}</Alert>
      ) : item.data === null ? (
        <Alert tone="info">Item de estoque não encontrado nesta empresa.</Alert>
      ) : (
        <div key={`${orgId}:${item.data.id}`} className="space-y-6">
          <Totals item={item.data} />
          {canEdit ? (
            <>
              <Section title="Movimentar" description="Registre entradas, saídas ou uma contagem.">
                <MovementForm item={item.data} />
              </Section>
              <Section
                title="Alerta de estoque baixo"
                description="O item é destacado quando o disponível chega a este valor. Vazio desativa."
              >
                <MinQuantityForm item={item.data} />
              </Section>
            </>
          ) : (
            <Alert tone="info">Somente proprietários e administradores movimentam estoque.</Alert>
          )}
          <Section
            title="Histórico"
            description="Últimas 50 movimentações. O histórico não pode ser alterado."
          >
            <History itemId={item.data.id} />
          </Section>
        </div>
      )}
    </div>
  );
}
