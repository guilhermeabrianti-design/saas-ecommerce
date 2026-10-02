import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { TextField } from '@/components/ui/TextField';
import { orgKindLabels } from '@/features/organizations/roles';
import { useGamificationConfig, useSaveAchievement, useSaveLevels, useSaveRule } from '../api';
import {
  gamificationErrorMessage,
  validateLevels,
  type AdminGamificationConfig,
  type LevelDraft,
} from '../gamification';

type Rule = AdminGamificationConfig['rules'][number];
type Achievement = AdminGamificationConfig['achievements'][number];

const intOrNull = (v: string) =>
  v.trim() === '' ? null : /^\d+$/.test(v.trim()) ? Number(v) : NaN;

function RuleRow({ rule }: { rule: Rule }) {
  const save = useSaveRule();
  const [points, setPoints] = useState(String(rule.points));
  const [cap, setCap] = useState(rule.daily_cap === null ? '' : String(rule.daily_cap));
  const [enabled, setEnabled] = useState(rule.enabled);
  const p = intOrNull(points);
  const c = intOrNull(cap);
  const valid =
    p !== null && !Number.isNaN(p) && p <= 10000 && !Number.isNaN(c) && (c === null || c >= 1);

  return (
    <li className="space-y-2 px-5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{rule.label}</p>
        <span className="text-muted text-xs">
          {rule.org_kind ? orgKindLabels[rule.org_kind] : 'Vendedor e fornecedor'}
        </span>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate({ event: rule.event, points: p!, dailyCap: c, enabled });
        }}
      >
        <div className="w-28">
          <TextField
            label="Pontos"
            inputMode="numeric"
            value={points}
            onChange={(e) => setPoints(e.target.value)}
          />
        </div>
        <div className="w-36">
          <TextField
            label="Limite por dia"
            inputMode="numeric"
            placeholder="Sem limite"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
          />
        </div>
        <label className="flex h-10 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Ativa
        </label>
        <Button type="submit" variant="secondary" disabled={!valid} loading={save.isPending}>
          Salvar
        </Button>
      </form>
      {save.isError && <Alert tone="error">{gamificationErrorMessage(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">Salvo. Vale para os próximos eventos.</Alert>}
    </li>
  );
}

function LevelsForm({ levels }: { levels: AdminGamificationConfig['levels'] }) {
  const save = useSaveLevels();
  const [draft, setDraft] = useState<LevelDraft[]>(() =>
    levels.map((l) => ({ name: l.name, min_points: String(l.min_points) })),
  );
  const { values, error } = validateLevels(draft);
  const set = (i: number, patch: Partial<LevelDraft>) =>
    setDraft((d) => d.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (values) save.mutate(values);
      }}
    >
      {draft.map((l, i) => (
        <div key={i} className="flex flex-wrap items-end gap-3">
          <div className="min-w-40 flex-1">
            <TextField
              label={`Nível ${i + 1}`}
              value={l.name}
              onChange={(e) => set(i, { name: e.target.value })}
            />
          </div>
          <div className="w-36">
            <TextField
              label="A partir de (pontos)"
              inputMode="numeric"
              value={l.min_points}
              onChange={(e) => set(i, { min_points: e.target.value })}
            />
          </div>
          <Button
            variant="ghost"
            aria-label={`Remover nível ${i + 1}`}
            disabled={draft.length <= 1}
            onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
          >
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </div>
      ))}
      {error && <Alert tone="info">{error}</Alert>}
      {save.isError && <Alert tone="error">{gamificationErrorMessage(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">Níveis salvos.</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={draft.length >= 20}
          onClick={() => setDraft((d) => [...d, { name: '', min_points: '' }])}
        >
          <Plus className="size-4" aria-hidden />
          Adicionar nível
        </Button>
        <Button type="submit" disabled={!values} loading={save.isPending}>
          Salvar níveis
        </Button>
      </div>
    </form>
  );
}

function AchievementRow({ a, eventLabel }: { a: Achievement; eventLabel: string }) {
  const save = useSaveAchievement();
  const [name, setName] = useState(a.name);
  const [description, setDescription] = useState(a.description);
  const [threshold, setThreshold] = useState(String(a.threshold));
  const [active, setActive] = useState(a.active);
  const t = intOrNull(threshold);
  const valid =
    name.trim().length >= 2 &&
    description.trim().length >= 2 &&
    t !== null &&
    !Number.isNaN(t) &&
    t >= 1;

  return (
    <li className="space-y-2 px-5 py-3">
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid)
            save.mutate({
              code: a.code,
              name: name.trim(),
              description: description.trim(),
              threshold: t!,
              active,
            });
        }}
      >
        <TextField
          label="Nome"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label={`Quantas vezes: ${eventLabel}`}
          inputMode="numeric"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
        />
        <div className="sm:col-span-2">
          <TextField
            label="Descrição"
            value={description}
            maxLength={200}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            Ativa
          </label>
          <Button type="submit" variant="secondary" disabled={!valid} loading={save.isPending}>
            Salvar
          </Button>
        </div>
      </form>
      {save.isError && <Alert tone="error">{gamificationErrorMessage(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">Conquista salva.</Alert>}
    </li>
  );
}

export function GamificationAdminPage() {
  const config = useGamificationConfig();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Gamificação</h1>
        <p className="text-muted text-sm">
          Pontos por eventos reais, níveis e conquistas. Mudanças valem dali em diante e ficam no
          registro de auditoria.
        </p>
      </div>
      {config.isPending ? (
        <PageLoader />
      ) : config.isError ? (
        <Alert tone="error">{gamificationErrorMessage(config.error)}</Alert>
      ) : (
        <>
          <p className="text-muted text-sm">
            Empresas com pontos: {config.data.organizations_with_points}
          </p>
          <Section
            title="Pontos por evento"
            description="Zero ou inativa desliga. O limite diário evita pontos em massa."
          >
            <ul className="divide-border -mx-5 divide-y">
              {config.data.rules.map((r) => (
                <RuleRow key={`${r.event}:${r.points}:${r.daily_cap}:${r.enabled}`} rule={r} />
              ))}
            </ul>
          </Section>
          <Section title="Níveis" description="O primeiro nível começa em 0 pontos.">
            <LevelsForm
              key={config.data.levels.map((l) => `${l.name}:${l.min_points}`).join('|')}
              levels={config.data.levels}
            />
          </Section>
          <Section
            title="Conquistas"
            description="Ganha quem repetir o evento a quantidade pedida."
          >
            <ul className="divide-border -mx-5 divide-y">
              {config.data.achievements.map((a) => (
                <AchievementRow
                  key={`${a.code}:${a.threshold}:${a.active}:${a.name}`}
                  a={a}
                  eventLabel={config.data.rules.find((r) => r.event === a.event)?.label ?? a.event}
                />
              ))}
            </ul>
          </Section>
        </>
      )}
    </div>
  );
}
