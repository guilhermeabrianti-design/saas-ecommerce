import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useFieldArray, useForm, useWatch, type Control } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, Plus, Search, Truck, X } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { useInventoryLevels, type InventoryLevel } from '@/features/inventory/api';
import { useOrganization } from '@/features/organizations/organization-context';
import { orgPermissions } from '@/features/organizations/roles';
import { describeAttributes } from '@/features/products/variants';
import { UFS } from '@/utils/br';
import { formatBRL } from '@/utils/money';
import { orderErrorMessage, useCreateOrder } from '../api';
import {
  emptyOrderForm,
  orderFormSchema,
  orderTotals,
  toOrderPayload,
  type OrderFormValues,
} from '../schemas';

function ItemPicker({
  onPick,
  pickedIds,
}: {
  onPick: (level: InventoryLevel) => void;
  pickedIds: string[];
}) {
  const { active } = useOrganization();
  const [search, setSearch] = useState('');
  const levels = useInventoryLevels(active!.organization.id, { search, lowOnly: false, page: 1 });
  const candidates = (levels.data?.items ?? []).filter(
    (l) => l.product_status === 'active' && l.is_active && !pickedIds.includes(l.id),
  );

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          className="text-muted pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          aria-hidden
        />
        <input
          type="search"
          aria-label="Buscar produto para adicionar"
          placeholder="Buscar produto ativo por nome ou SKU"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border-border bg-surface placeholder:text-muted/70 focus:border-brand focus:ring-brand/30 h-10 w-full rounded-lg border pr-3 pl-9 text-sm outline-none focus:ring-2"
        />
      </div>
      {levels.isPending ? (
        <PageLoader />
      ) : candidates.length === 0 ? (
        <p className="text-muted text-sm">Nenhum produto ativo encontrado.</p>
      ) : (
        <ul className="border-border divide-border max-h-64 divide-y overflow-y-auto rounded-lg border">
          {candidates.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                onClick={() => onPick(l)}
                className="hover:bg-surface-2 flex w-full items-center gap-3 px-3 py-2 text-left text-sm"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{l.product_name}</span>
                  <span className="text-muted block truncate text-xs">
                    <span className="font-mono">{l.sku}</span>
                    {l.attributes && ` · ${describeAttributes(l.attributes)}`}
                    {l.is_dropship ? ' · via fornecedor' : ` · ${l.available} disponíveis`}
                  </span>
                </span>
                <span className="tabular-nums">{formatBRL(l.price_cents)}</span>
                <Plus className="text-brand size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Totals({ control }: { control: Control<OrderFormValues> }) {
  const [items, shipping, discount] = useWatch({
    control,
    name: ['items', 'shipping', 'discount'],
  });
  const t = orderTotals({ items: items ?? [], shipping: shipping ?? '', discount: discount ?? '' });
  if (!t) return <p className="text-muted text-sm">Revise os valores para ver o total.</p>;
  return (
    <dl className="space-y-1 text-sm">
      {[
        ['Subtotal', t.subtotal],
        ['Frete', t.shipping],
        ['Desconto', -t.discount],
      ].map(([label, value]) => (
        <div key={label} className="flex justify-between">
          <dt className="text-muted">{label}</dt>
          <dd className="tabular-nums">{formatBRL(value as number)}</dd>
        </div>
      ))}
      <div className="border-border flex justify-between border-t pt-1 font-semibold">
        <dt>Total</dt>
        <dd className={t.total < 0 ? 'text-danger tabular-nums' : 'tabular-nums'}>
          {formatBRL(t.total)}
        </dd>
      </div>
    </dl>
  );
}

export function NewOrderPage() {
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const create = useCreateOrder(orgId);
  const navigate = useNavigate();
  // Same id across retries of this form: a double click or a retry after a
  // network error never creates two orders.
  const [requestId] = useState(() => crypto.randomUUID());

  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<OrderFormValues>({
    resolver: zodResolver(orderFormSchema),
    defaultValues: emptyOrderForm,
  });
  const items = useFieldArray({ control, name: 'items' });

  if (!orgPermissions.editCatalog(active!.role)) {
    return <Alert tone="info">Somente proprietários e administradores registram pedidos.</Alert>;
  }

  const onSubmit = handleSubmit((values) =>
    create.mutate(
      { payload: toOrderPayload(values), requestId },
      { onSuccess: (id) => void navigate(`/pedidos/${id}`, { replace: true }) },
    ),
  );

  return (
    <form onSubmit={onSubmit} noValidate className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          to="/pedidos"
          className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Pedidos
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Novo pedido</h1>
        <p className="text-muted mt-1 text-sm">
          O pedido nasce pendente. Estoque é reservado e fornecedores são acionados ao confirmar.
        </p>
      </div>

      {create.isError && <Alert tone="error">{orderErrorMessage(create.error)}</Alert>}

      <Section title="Itens" description="Produtos ativos do seu catálogo.">
        <div className="space-y-4">
          {items.fields.length > 0 && (
            <ul className="divide-border -mt-2 divide-y">
              {items.fields.map((f, i) => (
                <li key={f.id} className="flex flex-wrap items-start gap-3 py-3">
                  <div className="min-w-0 flex-1 pt-2 text-sm">
                    <p className="truncate font-medium">{f.label}</p>
                    <p className="text-muted text-xs">
                      {f.isDropship ? (
                        <span className="inline-flex items-center gap-1">
                          <Truck className="size-3" aria-hidden /> enviado pelo fornecedor
                        </span>
                      ) : (
                        `${f.available} disponíveis`
                      )}
                    </p>
                  </div>
                  <div className="w-24">
                    <TextField
                      label="Qtd."
                      inputMode="numeric"
                      error={errors.items?.[i]?.quantity?.message}
                      {...register(`items.${i}.quantity`)}
                    />
                  </div>
                  <div className="w-32">
                    <TextField
                      label="Preço unit."
                      inputMode="decimal"
                      placeholder={formatBRL(f.defaultPriceCents)}
                      error={errors.items?.[i]?.unitPrice?.message}
                      {...register(`items.${i}.unitPrice`)}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => items.remove(i)}
                    className="text-muted hover:text-fg mt-8 rounded p-1"
                    aria-label={`Remover ${f.label}`}
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {errors.items?.message && <p className="text-danger text-sm">{errors.items.message}</p>}
          <ItemPicker
            pickedIds={items.fields.map((f) => f.inventoryItemId)}
            onPick={(l) =>
              items.append({
                inventoryItemId: l.id,
                label: [l.product_name, l.attributes && describeAttributes(l.attributes)]
                  .filter(Boolean)
                  .join(' · '),
                defaultPriceCents: l.price_cents,
                available: l.available,
                isDropship: l.is_dropship,
                quantity: '1',
                unitPrice: '',
              })
            }
          />
        </div>
      </Section>

      <Section title="Cliente" description="Quem recebe o pedido.">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <TextField
              label="Nome"
              error={errors.customerName?.message}
              {...register('customerName')}
            />
          </div>
          <TextField
            label="E-mail (opcional)"
            type="email"
            error={errors.customerEmail?.message}
            {...register('customerEmail')}
          />
          <TextField
            label="Telefone (opcional)"
            inputMode="tel"
            error={errors.customerPhone?.message}
            {...register('customerPhone')}
          />
          <TextField
            label="CPF/CNPJ (opcional)"
            inputMode="numeric"
            hint="Necessário para nota fiscal e algumas transportadoras."
            error={errors.customerDocument?.message}
            {...register('customerDocument')}
          />
        </div>
      </Section>

      <Section title="Entrega" description="Endereço de entrega.">
        <div className="grid gap-4 sm:grid-cols-6">
          <div className="sm:col-span-2">
            <TextField
              label="CEP"
              inputMode="numeric"
              error={errors.postalCode?.message}
              {...register('postalCode')}
            />
          </div>
          <div className="sm:col-span-4">
            <TextField label="Rua" error={errors.street?.message} {...register('street')} />
          </div>
          <div className="sm:col-span-2">
            <TextField label="Número" error={errors.number?.message} {...register('number')} />
          </div>
          <div className="sm:col-span-4">
            <TextField
              label="Complemento (opcional)"
              error={errors.complement?.message}
              {...register('complement')}
            />
          </div>
          <div className="sm:col-span-2">
            <TextField label="Bairro" error={errors.district?.message} {...register('district')} />
          </div>
          <div className="sm:col-span-3">
            <TextField label="Cidade" error={errors.city?.message} {...register('city')} />
          </div>
          <div className="sm:col-span-1">
            <Select label="UF" {...register('state')}>
              <option value="">—</option>
              {UFS.map((uf) => (
                <option key={uf} value={uf}>
                  {uf}
                </option>
              ))}
            </Select>
            {errors.state?.message && (
              <p className="text-danger mt-1 text-xs">{errors.state.message}</p>
            )}
          </div>
        </div>
      </Section>

      <Section title="Valores" description="Frete e desconto do pedido.">
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-4">
            <TextField
              label="Frete (opcional)"
              inputMode="decimal"
              placeholder="0,00"
              error={errors.shipping?.message}
              {...register('shipping')}
            />
            <TextField
              label="Desconto (opcional)"
              inputMode="decimal"
              placeholder="0,00"
              error={errors.discount?.message}
              {...register('discount')}
            />
          </div>
          <Totals control={control} />
        </div>
      </Section>

      <Section title="Observações" description="Visível só para a sua empresa.">
        <textarea
          rows={3}
          aria-label="Observações"
          className="border-border bg-surface focus:border-brand focus:ring-brand/30 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2"
          {...register('notes')}
        />
      </Section>

      <Button type="submit" loading={create.isPending}>
        Registrar pedido
      </Button>
    </form>
  );
}
