import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { useAdminOrganizations } from '@/features/admin/api';
import { providerLabels } from '@/features/integrations/schemas';
import { formatBRL, parseBRL } from '@/utils/money';
import {
  useAdminListingSearch,
  useAdminSimulation,
  useCategories,
  useCommissionRules,
  useDeleteCommissionRule,
  useFeeRules,
  useSaveCategory,
  useSaveCommissionRule,
  useSetCategoryActive,
  useSetFeeRuleActive,
  type SplitInput,
} from '../api';
import { FeeRuleForm } from '../components/FeeRuleForm';
import { SplitInputs, SplitResult } from '../components/SplitCalculator';
import {
  bpsToInput,
  categoryPath,
  commissionScopeLabels,
  describeBand,
  feesErrorMessage,
  formatBps,
  parsePercentToBps,
  sortCategories,
  type Category,
  type CommissionScope,
  type FeeRule,
} from '../fees';

const PRESETS = [1000, 1500, 2000, 2500];

function ErrorText({ error }: { error: unknown }) {
  return <p className="text-danger text-xs">{feesErrorMessage(error)}</p>;
}

// ---------------------------------------------------------------------
// Comissão padrão
// ---------------------------------------------------------------------
function DefaultCommission({ currentBps }: { currentBps: number | null }) {
  const save = useSaveCommissionRule();
  const [text, setText] = useState(bpsToInput(currentBps));
  const bps = parsePercentToBps(text);

  return (
    <div className="space-y-3">
      <p className="text-sm">
        Atual:{' '}
        <strong className="text-lg tabular-nums">
          {currentBps == null ? 'não configurada' : formatBps(currentBps)}
        </strong>{' '}
        do preço de venda.
      </p>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <Button
            key={p}
            variant={p === currentBps ? 'primary' : 'secondary'}
            disabled={save.isPending}
            onClick={() => {
              setText(bpsToInput(p));
              save.mutate({ scope: 'default', target: null, bps: p });
            }}
          >
            {formatBps(p)}
          </Button>
        ))}
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (bps !== null) save.mutate({ scope: 'default', target: null, bps });
        }}
      >
        <div className="w-40">
          <TextField
            label="Outro valor (%)"
            inputMode="decimal"
            value={text}
            onChange={(e) => setText(e.target.value)}
            error={text && bps === null ? 'Entre 0 e 100.' : undefined}
          />
        </div>
        <Button
          type="submit"
          variant="secondary"
          loading={save.isPending}
          disabled={bps === null || bps === currentBps}
        >
          Salvar
        </Button>
      </form>
      {save.isError && <ErrorText error={save.error} />}
      {save.isSuccess && <p className="text-success text-xs">Comissão padrão atualizada.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------
// Regras específicas de comissão
// ---------------------------------------------------------------------
function TargetPicker({
  scope,
  categories,
  value,
  onChange,
}: {
  scope: Exclude<CommissionScope, 'default'>;
  categories: Category[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const orgs = useAdminOrganizations(scope === 'seller' ? search : '', 1);
  const listings = useAdminListingSearch(scope === 'product' ? search : '');

  if (scope === 'category') {
    return (
      <Select label="Categoria" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Escolha…</option>
        {sortCategories(categories).map((c) => (
          <option key={c.id} value={c.id}>
            {categoryPath(c, categories)}
          </option>
        ))}
      </Select>
    );
  }

  const options =
    scope === 'seller'
      ? (orgs.data?.items ?? [])
          .filter((o) => o.kind === 'seller')
          .map((o) => ({ id: o.id, label: o.name }))
      : (listings.data ?? []).map((l) => ({
          id: l.listing_id,
          label: `${l.product_name} — ${l.supplier_name}${l.is_published ? '' : ' (não publicado)'}`,
        }));

  return (
    <div className="space-y-2">
      <TextField
        label={scope === 'seller' ? 'Buscar vendedor' : 'Buscar produto ou fornecedor'}
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          onChange('');
        }}
        hint={scope === 'product' ? 'Digite ao menos 2 letras.' : undefined}
      />
      <Select
        aria-label={scope === 'seller' ? 'Vendedor' : 'Produto'}
        className="w-full"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{options.length ? 'Escolha…' : 'Nenhum resultado'}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

function CommissionRules({ categories }: { categories: Category[] }) {
  const rules = useCommissionRules();
  const save = useSaveCommissionRule();
  const remove = useDeleteCommissionRule();
  const [scope, setScope] = useState<Exclude<CommissionScope, 'default'>>('category');
  const [target, setTarget] = useState('');
  const [text, setText] = useState('');
  const bps = parsePercentToBps(text);

  if (rules.isPending) return <PageLoader />;
  if (rules.isError) return <Alert tone="error">{feesErrorMessage(rules.error)}</Alert>;
  const defaultRule = rules.data.find((r) => r.scope === 'default');
  const specific = rules.data.filter((r) => r.scope !== 'default');

  return (
    <div className="space-y-6">
      <DefaultCommission
        key={defaultRule?.percent_bps}
        currentBps={defaultRule?.percent_bps ?? null}
      />

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Exceções</h3>
        <p className="text-muted text-sm">
          Precedência: produto › vendedor › subcategoria › categoria-mãe › padrão. Comissão por
          campanha chega com as campanhas.
        </p>
        {specific.length === 0 ? (
          <p className="text-muted text-sm">Nenhuma exceção: vale a comissão padrão.</p>
        ) : (
          <ul className="divide-border divide-y text-sm">
            {specific.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-2">
                <span className="bg-surface-2 rounded-full px-2 py-0.5 text-xs">
                  {commissionScopeLabels[r.scope]}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {r.target_name ?? '—'}
                  {r.target_detail && <span className="text-muted"> · {r.target_detail}</span>}
                </span>
                <strong className="tabular-nums">{formatBps(r.percent_bps)}</strong>
                <Button
                  variant="ghost"
                  aria-label={`Remover exceção de ${r.target_name ?? ''}`}
                  loading={remove.isPending && remove.variables === r.id}
                  onClick={() => remove.mutate(r.id)}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {remove.isError && <ErrorText error={remove.error} />}

        <form
          className="border-border grid gap-3 rounded-lg border p-4 sm:grid-cols-[10rem_1fr_8rem_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (target && bps !== null) {
              save.mutate(
                { scope, target, bps },
                {
                  onSuccess: () => {
                    setTarget('');
                    setText('');
                  },
                },
              );
            }
          }}
        >
          <Select
            label="Aplicar a"
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as typeof scope);
              setTarget('');
            }}
          >
            <option value="category">Categoria</option>
            <option value="product">Produto</option>
            <option value="seller">Vendedor</option>
          </Select>
          <TargetPicker
            key={scope}
            scope={scope}
            categories={categories}
            value={target}
            onChange={setTarget}
          />
          <TextField
            label="Comissão (%)"
            inputMode="decimal"
            value={text}
            onChange={(e) => setText(e.target.value)}
            error={text && bps === null ? 'Entre 0 e 100.' : undefined}
          />
          <Button type="submit" loading={save.isPending} disabled={!target || bps === null}>
            Salvar
          </Button>
          {save.isError && (
            <div className="sm:col-span-4">
              <ErrorText error={save.error} />
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Taxas de marketplace
// ---------------------------------------------------------------------
function FeeRuleRow({
  rule,
  categories,
  onEdit,
}: {
  rule: FeeRule;
  categories: Category[];
  onEdit: () => void;
}) {
  const setActive = useSetFeeRuleActive();
  const category = categories.find((c) => c.id === rule.category_id);
  return (
    <li className="flex flex-wrap items-start gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {rule.label}
          <span className="text-muted font-mono text-xs"> ({rule.listing_type})</span>
          {rule.campaign && (
            <span className="bg-brand/10 text-brand ml-2 rounded-full px-2 py-0.5 text-xs">
              + campanha {rule.campaign}
            </span>
          )}
          {!rule.is_active && (
            <span className="bg-surface-2 text-muted ml-2 rounded-full px-2 py-0.5 text-xs">
              Inativa
            </span>
          )}
        </p>
        <p className="text-muted text-xs">
          {category ? categoryPath(category, categories) : 'Todas as categorias'} ·{' '}
          {describeBand(rule.min_unit_price_cents, rule.max_unit_price_cents, formatBRL)}
        </p>
        {rule.notes && <p className="text-muted text-xs">{rule.notes}</p>}
        {setActive.isError && <ErrorText error={setActive.error} />}
      </div>
      <strong className="tabular-nums">
        {formatBps(rule.percent_bps)}
        {rule.fixed_cents_per_item > 0 && ` + ${formatBRL(rule.fixed_cents_per_item)}/item`}
      </strong>
      <span className="flex gap-1">
        <Button variant="ghost" aria-label={`Editar ${rule.label}`} onClick={onEdit}>
          <Pencil className="size-4" aria-hidden />
        </Button>
        <Button
          variant="secondary"
          loading={setActive.isPending}
          onClick={() => setActive.mutate({ id: rule.id, active: !rule.is_active })}
        >
          {rule.is_active ? 'Desativar' : 'Ativar'}
        </Button>
      </span>
    </li>
  );
}

function FeeRules({ categories }: { categories: Category[] }) {
  const rules = useFeeRules();
  const [editing, setEditing] = useState<FeeRule | 'new' | null>(null);

  if (rules.isPending) return <PageLoader />;
  if (rules.isError) return <Alert tone="error">{feesErrorMessage(rules.error)}</Alert>;
  const providersWithRules = [...new Set(rules.data.map((r) => r.provider))];

  return (
    <div className="space-y-4">
      {editing === null ? (
        <Button variant="secondary" onClick={() => setEditing('new')}>
          <Plus className="size-4" aria-hidden />
          Nova regra
        </Button>
      ) : (
        <FeeRuleForm
          key={editing === 'new' ? 'new' : editing.id}
          rule={editing === 'new' ? null : editing}
          categories={categories}
          onDone={() => setEditing(null)}
        />
      )}
      {providersWithRules.length === 0 && (
        <p className="text-muted text-sm">Nenhuma taxa cadastrada.</p>
      )}
      {providersWithRules.map((provider) => (
        <div key={provider}>
          <h3 className="text-sm font-semibold">{providerLabels[provider]}</h3>
          <ul className="divide-border divide-y text-sm">
            {rules.data
              .filter((r) => r.provider === provider)
              .map((r) => (
                <FeeRuleRow
                  key={r.id}
                  rule={r}
                  categories={categories}
                  onEdit={() => setEditing(r)}
                />
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------
// Simulador
// ---------------------------------------------------------------------
function Simulator({ categories }: { categories: Category[] }) {
  const [input, setInput] = useState<SplitInput | null>(null);
  const [categoryId, setCategoryId] = useState('');
  const [cost, setCost] = useState('40,00');
  const costCents = parseBRL(cost);
  const sim = useAdminSimulation(
    input && costCents !== null
      ? { ...input, categoryId: categoryId || null, supplierUnitCents: costCents }
      : null,
  );

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <SplitInputs
        defaultPriceCents={10000}
        onChange={setInput}
        extra={
          <>
            <TextField
              label="Custo do fornecedor (unitário)"
              inputMode="decimal"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              error={costCents === null ? 'Valor inválido, ex.: 40,00' : undefined}
            />
            <Select
              label="Categoria"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">Sem categoria</option>
              {sortCategories(categories).map((c) => (
                <option key={c.id} value={c.id}>
                  {categoryPath(c, categories)}
                </option>
              ))}
            </Select>
          </>
        }
      />
      {input && costCents !== null ? (
        <SplitResult query={sim} />
      ) : (
        <p className="text-muted text-sm">Preencha preço e custo para simular.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Categorias
// ---------------------------------------------------------------------
function CategoryRow({ category }: { category: Category }) {
  const setActive = useSetCategoryActive();
  const save = useSaveCategory();
  const [name, setName] = useState<string | null>(null);

  return (
    <li className={`flex flex-wrap items-center gap-2 py-2 ${category.parent_id ? 'pl-6' : ''}`}>
      {name === null ? (
        <span className="min-w-0 flex-1">
          {category.name}
          {!category.is_active && <span className="text-muted text-xs"> (desativada)</span>}
        </span>
      ) : (
        <form
          className="flex min-w-0 flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(
              { id: category.id, name, parentId: category.parent_id },
              { onSuccess: () => setName(null) },
            );
          }}
        >
          <input
            aria-label="Nome da categoria"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            autoFocus
            className="border-border bg-surface h-9 min-w-0 flex-1 rounded-lg border px-2 text-sm"
          />
          <Button type="submit" variant="secondary" loading={save.isPending}>
            Salvar
          </Button>
        </form>
      )}
      {name === null && (
        <Button
          variant="ghost"
          aria-label={`Renomear ${category.name}`}
          onClick={() => setName(category.name)}
        >
          <Pencil className="size-4" aria-hidden />
        </Button>
      )}
      <Button
        variant="secondary"
        loading={setActive.isPending}
        onClick={() => setActive.mutate({ id: category.id, active: !category.is_active })}
      >
        {category.is_active ? 'Desativar' : 'Ativar'}
      </Button>
      {(save.isError || setActive.isError) && (
        <div className="w-full">
          <ErrorText error={save.error ?? setActive.error} />
        </div>
      )}
    </li>
  );
}

function Categories({ categories }: { categories: Category[] }) {
  const save = useSaveCategory();
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const roots = sortCategories(categories).filter((c) => !c.parent_id);

  return (
    <div className="space-y-4">
      {categories.length === 0 ? (
        <p className="text-muted text-sm">Nenhuma categoria cadastrada.</p>
      ) : (
        <ul className="divide-border divide-y text-sm">
          {sortCategories(categories).map((c) => (
            <CategoryRow key={c.id} category={c} />
          ))}
        </ul>
      )}
      <form
        className="border-border grid gap-3 rounded-lg border p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(
            { id: null, name, parentId: parentId || null },
            { onSuccess: () => setName('') },
          );
        }}
      >
        <TextField
          label="Nova categoria"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
        />
        <Select label="Dentro de" value={parentId} onChange={(e) => setParentId(e.target.value)}>
          <option value="">— (categoria principal)</option>
          {roots.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Button type="submit" loading={save.isPending} disabled={name.trim().length < 2}>
          Adicionar
        </Button>
        {save.isError && (
          <div className="sm:col-span-3">
            <ErrorText error={save.error} />
          </div>
        )}
      </form>
    </div>
  );
}

export function FeesAdminPage() {
  const categories = useCategories();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link to="/admin" className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm">
        <ArrowLeft className="size-4" aria-hidden />
        Administração
      </Link>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Taxas e comissões</h1>
        <p className="text-muted text-sm">
          Venda − taxas do marketplace − fornecedor − comissão do vendedor = receita da TheSigns.
          Toda alteração fica registrada na auditoria.
        </p>
      </div>

      {categories.isPending ? (
        <PageLoader />
      ) : categories.isError ? (
        <Alert tone="error">{feesErrorMessage(categories.error)}</Alert>
      ) : (
        <>
          <Section
            title="Simulador"
            description="Confira a divisão com as regras atuais antes de alterar algo."
          >
            <Simulator categories={categories.data} />
          </Section>
          <Section
            title="Comissão do vendedor"
            description="Percentual do preço de venda pago ao vendedor/criador."
          >
            <CommissionRules categories={categories.data} />
          </Section>
          <Section
            title="Taxas de marketplace"
            description="Por marketplace, tipo de anúncio, categoria, faixa de preço e campanha. Atualize quando o marketplace mudar a tabela."
          >
            <FeeRules categories={categories.data} />
          </Section>
          <Section
            title="Categorias"
            description="Dois níveis (categoria e subcategoria). Usadas nas taxas, comissões e no catálogo."
          >
            <Categories categories={categories.data} />
          </Section>
        </>
      )}
    </div>
  );
}
