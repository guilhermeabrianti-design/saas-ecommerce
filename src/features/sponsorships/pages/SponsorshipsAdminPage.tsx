import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { formatBRL } from '@/utils/money';
import { useAdminSponsorships, useSavePackage } from '../api';
import {
  campaignState,
  durationLabel,
  packageDraftToInput,
  placementLabels,
  placements,
  sponsorshipErrorMessage,
  toPackageDraft,
  type AdminPackage,
  type PackageDraft,
  type Placement,
} from '../sponsorships';

const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

function PackageForm({ pkg, onDone }: { pkg: AdminPackage | null; onDone?: () => void }) {
  const save = useSavePackage();
  const [d, setD] = useState<PackageDraft>(toPackageDraft(pkg));
  const input = packageDraftToInput(d, pkg?.id ?? null);
  const set = (patch: Partial<PackageDraft>) => setD((prev) => ({ ...prev, ...patch }));

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (input) save.mutate(input, { onSuccess: () => onDone?.() });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {!pkg && (
          <Select
            label="Onde aparece"
            value={d.placement}
            onChange={(e) => set({ placement: e.target.value as Placement })}
          >
            {placements.map((p) => (
              <option key={p} value={p}>
                {placementLabels[p]}
              </option>
            ))}
          </Select>
        )}
        <TextField label="Nome" value={d.name} onChange={(e) => set({ name: e.target.value })} />
        <TextField
          label="Dias"
          inputMode="numeric"
          value={d.days}
          onChange={(e) => set({ days: e.target.value })}
        />
        <TextField
          label="Preço"
          inputMode="decimal"
          placeholder="29,90"
          value={d.price}
          onChange={(e) => set({ price: e.target.value })}
        />
        <TextField
          label="Campanhas ao mesmo tempo"
          inputMode="numeric"
          placeholder="Sem limite"
          value={d.maxActive}
          onChange={(e) => set({ maxActive: e.target.value })}
        />
        <TextField
          label="Ordem"
          inputMode="numeric"
          value={d.position}
          onChange={(e) => set({ position: e.target.value })}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4"
          checked={d.active}
          onChange={(e) => set({ active: e.target.checked })}
        />
        À venda
      </label>
      {!input && (
        <p className="text-muted text-xs">
          Nome de 2 a 60 caracteres, de 1 a 90 dias e preço a partir de R$ 1,00.
        </p>
      )}
      <Button type="submit" variant="secondary" disabled={!input} loading={save.isPending}>
        {pkg ? 'Salvar' : 'Criar pacote'}
      </Button>
      {save.isError && <Alert tone="error">{sponsorshipErrorMessage(save.error)}</Alert>}
      {save.isSuccess && pkg && <Alert tone="success">Salvo. Vale para as próximas compras.</Alert>}
    </form>
  );
}

export function SponsorshipsAdminPage() {
  const data = useAdminSponsorships();
  const [creating, setCreating] = useState(false);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Patrocínios</h1>
        <p className="text-muted text-sm">
          Pacotes de destaque pago que os fornecedores compram para seus anúncios.
        </p>
      </div>
      {data.isPending ? (
        <PageLoader />
      ) : data.isError ? (
        <Alert tone="error">{sponsorshipErrorMessage(data.error)}</Alert>
      ) : (
        <>
          <div className="border-border bg-surface grid gap-4 rounded-xl border p-5 sm:grid-cols-2">
            <div>
              <p className="text-muted text-xs">Vendido nos últimos 30 dias</p>
              <p className="text-2xl font-semibold tabular-nums">
                {formatBRL(data.data.revenue_30d_cents)}
              </p>
            </div>
            <div>
              <p className="text-muted text-xs">Campanhas no ar</p>
              <p className="text-2xl font-semibold tabular-nums">
                {data.data.packages.reduce((n, p) => n + p.live, 0)}
              </p>
            </div>
          </div>

          <Section
            title="Pacotes"
            description="Onde aparece, por quanto tempo, preço e quantas campanhas por vez."
          >
            {data.data.packages.length === 0 && (
              <p className="text-muted text-sm">Nenhum pacote cadastrado.</p>
            )}
            <ul className="divide-border -mx-5 divide-y">
              {data.data.packages.map((p) => (
                <li key={p.id} className="space-y-3 px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">
                      {p.name} · {formatBRL(p.price_cents)} · {durationLabel(p.duration_days)}
                      {!p.active && <span className="text-muted"> (fora de venda)</span>}
                    </p>
                    <span className="text-muted text-xs">
                      {placementLabels[p.placement]} · {p.live} no ar
                      {p.max_active !== null && ` de ${p.max_active}`}
                    </span>
                  </div>
                  <PackageForm pkg={p} />
                </li>
              ))}
            </ul>
            <div className="mt-4">
              {creating ? (
                <div className="border-border space-y-3 rounded-lg border p-4">
                  <p className="font-medium">Novo pacote</p>
                  <PackageForm pkg={null} onDone={() => setCreating(false)} />
                </div>
              ) : (
                <Button variant="secondary" onClick={() => setCreating(true)}>
                  <Plus className="size-4" aria-hidden />
                  Novo pacote
                </Button>
              )}
            </div>
          </Section>

          <Section title="Campanhas" description="As 100 mais recentes já pagas.">
            {data.data.campaigns.length === 0 ? (
              <p className="text-muted text-sm">Nenhuma campanha ainda.</p>
            ) : (
              <ul className="divide-border -mx-5 divide-y text-sm">
                {data.data.campaigns.map((c) => (
                  <li key={c.id} className="flex flex-wrap justify-between gap-3 px-5 py-2">
                    <span>
                      {c.listing_name}
                      <span className="text-muted block text-xs">
                        {c.supplier_name} · {placementLabels[c.placement]}
                        {c.starts_at && ` · desde ${day(c.starts_at)}`}
                      </span>
                    </span>
                    <span className="text-right">
                      {campaignState(c)}
                      <span className="text-muted block text-xs tabular-nums">
                        {formatBRL(c.price_cents)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
