import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, ImageOff } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { Pager } from '@/features/admin/components/Pager';
import { useCategories } from '@/features/fees/api';
import { categoryPath, sortCategories, type Category } from '@/features/fees/fees';
import { cn } from '@/utils/cn';
import { formatBRL } from '@/utils/money';
import {
  MODERATION_PAGE_SIZE,
  useModerateListing,
  useModerationListings,
  useReviewSupplier,
  useSupplierReviews,
  useUpdateListingContent,
} from '../api';
import {
  actionLabels,
  allowedActions,
  approvalLabels,
  approvalStatuses,
  listingModerations,
  moderationErrorMessage,
  moderationLabels,
  moderationTones,
  needsReason,
  validReason,
  type ApprovalStatus,
  type ListingModeration,
  type ModerationAction,
  type ModerationListing,
  type SupplierReview,
} from '../moderation';

const when = (iso: string) => new Date(iso).toLocaleString('pt-BR');

function Badge({ tone, children }: { tone: string; children: string }) {
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', tone)}>{children}</span>
  );
}

const approvalTone: Record<ApprovalStatus, string> = {
  pending: moderationTones.pending,
  approved: moderationTones.approved,
  rejected: moderationTones.rejected,
};

/** Campo de motivo + confirmação para reprovar/bloquear. */
function ReasonForm({
  action,
  pending,
  onConfirm,
  onCancel,
}: {
  action: ModerationAction | 'reject_supplier';
  pending: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const label = action === 'block' ? 'bloqueio' : 'reprovação';
  return (
    <form
      className="flex w-full flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (validReason(reason)) onConfirm(reason);
      }}
    >
      <div className="min-w-56 flex-1">
        <TextField
          label={`Motivo da ${label} (o fornecedor verá)`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          autoFocus
        />
      </div>
      <Button type="submit" variant="danger" loading={pending} disabled={!validReason(reason)}>
        Confirmar {label}
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        Cancelar
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------
// Anúncios
// ---------------------------------------------------------------------
function EditContent({
  item,
  categories,
  onDone,
}: {
  item: ModerationListing;
  categories: Category[];
  onDone: () => void;
}) {
  const update = useUpdateListingContent();
  const [name, setName] = useState(item.product_name);
  const [description, setDescription] = useState(item.description);
  const [categoryId, setCategoryId] = useState(item.category_id ?? '');
  const valid = name.trim().length >= 2 && name.trim().length <= 200 && description.length <= 5000;

  return (
    <form
      className="border-border w-full space-y-3 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) {
          update.mutate(
            { listingId: item.listing_id, name, description, categoryId: categoryId || null },
            { onSuccess: onDone },
          );
        }
      }}
    >
      {update.isError && <Alert tone="error">{moderationErrorMessage(update.error)}</Alert>}
      <TextField
        label="Nome"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={200}
      />
      <div className="space-y-1.5">
        <label htmlFor={`desc-${item.listing_id}`} className="block text-sm font-medium">
          Descrição
        </label>
        <textarea
          id={`desc-${item.listing_id}`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={5000}
          rows={5}
          className="border-border bg-surface focus:border-brand focus:ring-brand/30 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2"
        />
      </div>
      <Select label="Categoria" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
        <option value="">Sem categoria</option>
        {sortCategories(categories)
          .filter((c) => c.is_active || c.id === item.category_id)
          .map((c) => (
            <option key={c.id} value={c.id}>
              {categoryPath(c, categories)}
            </option>
          ))}
      </Select>
      <p className="text-muted text-xs">
        A alteração vale para o produto do fornecedor e fica registrada na auditoria.
      </p>
      <div className="flex gap-2">
        <Button type="submit" loading={update.isPending} disabled={!valid}>
          Salvar correção
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function ListingCard({
  item,
  categories,
}: {
  item: ModerationListing & { image_urls: (string | null)[] };
  categories: Category[];
}) {
  const moderate = useModerateListing();
  const [asking, setAsking] = useState<ModerationAction | null>(null);
  const [editing, setEditing] = useState(false);
  const category = categories.find((c) => c.id === item.category_id);

  const run = (action: ModerationAction, reason = '') =>
    moderate.mutate(
      { listingId: item.listing_id, action, reason },
      { onSuccess: () => setAsking(null) },
    );

  return (
    <li className="space-y-3 py-4">
      <div className="flex flex-wrap gap-4">
        <div className="flex gap-2">
          {item.image_urls.length === 0 ? (
            <div className="border-border bg-surface-2 grid size-20 place-items-center rounded-lg border">
              <ImageOff className="text-muted size-5" aria-label="Sem imagens" />
            </div>
          ) : (
            item.image_urls.map((url, i) =>
              url ? (
                <a key={url} href={url} target="_blank" rel="noreferrer">
                  <img
                    src={url}
                    alt={`${item.product_name} — imagem ${i + 1}`}
                    className="border-border size-20 rounded-lg border object-cover"
                    loading="lazy"
                  />
                </a>
              ) : null,
            )
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{item.product_name}</span>
            <Badge tone={moderationTones[item.moderation_status]}>
              {moderationLabels[item.moderation_status]}
            </Badge>
          </p>
          <p className="text-muted text-xs">
            {item.supplier_name}{' '}
            {item.supplier_approval !== 'approved' && (
              <Badge tone={approvalTone[item.supplier_approval]}>
                {`fornecedor ${approvalLabels[item.supplier_approval].toLowerCase()}`}
              </Badge>
            )}{' '}
            · SKU {item.sku}
            {item.brand && ` · ${item.brand}`} ·{' '}
            {category ? categoryPath(category, categories) : 'sem categoria'}
          </p>
          <p className="text-xs">
            Atacado {formatBRL(item.wholesale_price_cents)}
            {item.suggested_price_cents != null &&
              ` · sugerido ${formatBRL(item.suggested_price_cents)}`}{' '}
            · {item.is_published ? 'publicado' : 'não publicado'} · produto{' '}
            {item.product_status === 'active' ? 'ativo' : 'inativo'} · atualizado{' '}
            {when(item.updated_at)}
          </p>
          {item.moderation_reason && (
            <p className="text-danger text-xs">Motivo: {item.moderation_reason}</p>
          )}
          {item.description && (
            <details className="text-xs">
              <summary className="text-muted cursor-pointer">Descrição</summary>
              <p className="mt-1 whitespace-pre-line">{item.description}</p>
            </details>
          )}
        </div>
      </div>

      {editing ? (
        <EditContent item={item} categories={categories} onDone={() => setEditing(false)} />
      ) : asking ? (
        <ReasonForm
          action={asking}
          pending={moderate.isPending}
          onConfirm={(reason) => run(asking, reason)}
          onCancel={() => setAsking(null)}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {allowedActions(item.moderation_status).map((action) => (
            <Button
              key={action}
              variant={
                action === 'approve' ? 'primary' : action === 'block' ? 'danger' : 'secondary'
              }
              loading={moderate.isPending && moderate.variables?.action === action}
              onClick={() => (needsReason(action) ? setAsking(action) : run(action))}
            >
              {actionLabels[action]}
            </Button>
          ))}
          <Button variant="ghost" onClick={() => setEditing(true)}>
            Corrigir conteúdo
          </Button>
        </div>
      )}
      {moderate.isError && (
        <p className="text-danger text-xs">{moderationErrorMessage(moderate.error)}</p>
      )}
    </li>
  );
}

function Listings({ categories }: { categories: Category[] }) {
  const [status, setStatus] = useState<ListingModeration | ''>('pending');
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const listings = useModerationListings(status || null, search, page);

  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setSearch(input.trim());
        }}
      >
        <Select
          aria-label="Situação"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as ListingModeration | '');
            setPage(1);
          }}
        >
          <option value="">Todas as situações</option>
          {listingModerations.map((s) => (
            <option key={s} value={s}>
              {moderationLabels[s]}
            </option>
          ))}
        </Select>
        <input
          aria-label="Buscar anúncio"
          placeholder="Produto, SKU ou fornecedor"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="border-border bg-surface focus:border-brand focus:ring-brand/30 h-10 min-w-0 flex-1 rounded-lg border px-3 text-sm outline-none focus:ring-2"
        />
        <Button type="submit" variant="secondary">
          Buscar
        </Button>
      </form>

      {listings.isPending ? (
        <PageLoader />
      ) : listings.isError ? (
        <Alert tone="error">{moderationErrorMessage(listings.error)}</Alert>
      ) : listings.data.items.length === 0 ? (
        <p className="text-muted text-sm">
          {status === 'pending' && !search
            ? 'Nenhum anúncio aguardando análise.'
            : 'Nenhum anúncio encontrado.'}
        </p>
      ) : (
        <ul className="divide-border -my-4 divide-y">
          {listings.data.items.map((item) => (
            <ListingCard
              key={`${item.listing_id}-${item.moderation_status}-${item.updated_at}`}
              item={item}
              categories={categories}
            />
          ))}
        </ul>
      )}
      {listings.data && (
        <Pager
          page={page}
          total={listings.data.total}
          pageSize={MODERATION_PAGE_SIZE}
          onPage={setPage}
          noun="anúncios"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Fornecedores
// ---------------------------------------------------------------------
function SupplierRow({ supplier }: { supplier: SupplierReview }) {
  const review = useReviewSupplier();
  const [asking, setAsking] = useState(false);
  const s = supplier;

  return (
    <li className="flex flex-wrap items-start gap-3 py-3 text-sm">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{s.name}</span>
          <Badge tone={approvalTone[s.approval_status]}>{approvalLabels[s.approval_status]}</Badge>
          {s.suspended_at && <Badge tone={moderationTones.blocked}>Suspensa</Badge>}
        </p>
        <p className="text-muted text-xs">
          {s.owner_name ?? 'Responsável removido'}
          {s.owner_email && ` · ${s.owner_email}`} · cadastro em {when(s.created_at)}
        </p>
        <p className="text-muted text-xs">
          {s.products} produto(s) · {s.listings} anúncio(s) no catálogo
        </p>
        {s.approval_reason && <p className="text-danger text-xs">Motivo: {s.approval_reason}</p>}
      </div>
      {asking ? (
        <ReasonForm
          action="reject_supplier"
          pending={review.isPending}
          onConfirm={(reason) =>
            review.mutate(
              { orgId: s.id, approve: false, reason },
              { onSuccess: () => setAsking(false) },
            )
          }
          onCancel={() => setAsking(false)}
        />
      ) : (
        <span className="flex gap-2">
          {s.approval_status !== 'approved' && (
            <Button
              loading={review.isPending}
              onClick={() => review.mutate({ orgId: s.id, approve: true, reason: '' })}
            >
              Aprovar
            </Button>
          )}
          {s.approval_status === 'pending' && (
            <Button variant="secondary" onClick={() => setAsking(true)}>
              Reprovar
            </Button>
          )}
        </span>
      )}
      {review.isError && (
        <p className="text-danger w-full text-xs">{moderationErrorMessage(review.error)}</p>
      )}
    </li>
  );
}

function Suppliers() {
  const [status, setStatus] = useState<ApprovalStatus | ''>('pending');
  const [page, setPage] = useState(1);
  const suppliers = useSupplierReviews(status || null, page);

  return (
    <div className="space-y-4">
      <Select
        aria-label="Situação do fornecedor"
        value={status}
        onChange={(e) => {
          setStatus(e.target.value as ApprovalStatus | '');
          setPage(1);
        }}
      >
        <option value="">Todas as situações</option>
        {approvalStatuses.map((s) => (
          <option key={s} value={s}>
            {approvalLabels[s]}
          </option>
        ))}
      </Select>
      {suppliers.isPending ? (
        <PageLoader />
      ) : suppliers.isError ? (
        <Alert tone="error">{moderationErrorMessage(suppliers.error)}</Alert>
      ) : suppliers.data.items.length === 0 ? (
        <p className="text-muted text-sm">
          {status === 'pending' ? 'Nenhum fornecedor aguardando análise.' : 'Nenhum fornecedor.'}
        </p>
      ) : (
        <ul className="divide-border -my-3 divide-y">
          {suppliers.data.items.map((s) => (
            <SupplierRow key={`${s.id}-${s.approval_status}`} supplier={s} />
          ))}
        </ul>
      )}
      {suppliers.data && (
        <Pager
          page={page}
          total={suppliers.data.total}
          pageSize={MODERATION_PAGE_SIZE}
          onPage={setPage}
          noun="fornecedores"
        />
      )}
    </div>
  );
}

export function ModerationPage() {
  const categories = useCategories();
  const [tab, setTab] = useState<'listings' | 'suppliers'>('listings');

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link to="/admin" className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm">
        <ArrowLeft className="size-4" aria-hidden />
        Administração
      </Link>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Moderação</h1>
        <p className="text-muted text-sm">
          Um produto só aparece para os vendedores quando o fornecedor e o anúncio estão aprovados.
          Toda decisão fica registrada na auditoria.
        </p>
      </div>
      <div className="flex gap-2" role="group" aria-label="O que moderar">
        <Button
          variant={tab === 'listings' ? 'primary' : 'secondary'}
          aria-pressed={tab === 'listings'}
          onClick={() => setTab('listings')}
        >
          Anúncios
        </Button>
        <Button
          variant={tab === 'suppliers' ? 'primary' : 'secondary'}
          aria-pressed={tab === 'suppliers'}
          onClick={() => setTab('suppliers')}
        >
          Fornecedores
        </Button>
      </div>

      {tab === 'suppliers' ? (
        <Section title="Fornecedores" description="Aprovar libera o catálogo da empresa.">
          <Suppliers />
        </Section>
      ) : categories.isPending ? (
        <PageLoader />
      ) : categories.isError ? (
        <Alert tone="error">{moderationErrorMessage(categories.error)}</Alert>
      ) : (
        <Section
          title="Anúncios"
          description="Reprovar permite que o fornecedor corrija e reenvie; bloquear, só a equipe desfaz."
        >
          <Listings categories={categories.data} />
        </Section>
      )}
    </div>
  );
}
