import { Lock, Medal, Trophy } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Section } from '@/components/ui/Section';
import { useOrganization } from '@/features/organizations/organization-context';
import { cn } from '@/utils/cn';
import { useGamificationSummary, useRanking, useSetRankingVisibility } from '../api';
import {
  formatPoints,
  gamificationErrorMessage,
  levelProgress,
  monthLabel,
  type GamificationSummary,
} from '../gamification';

const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

function LevelCard({ s }: { s: GamificationSummary }) {
  const progress = levelProgress(s);
  return (
    <div className="border-border bg-surface grid gap-4 rounded-xl border p-5 sm:grid-cols-3">
      <div>
        <p className="text-muted text-xs">Nível</p>
        <p className="flex items-center gap-2 text-2xl font-semibold">
          <Trophy className="text-brand size-6" aria-hidden />
          {s.level?.name ?? '—'}
        </p>
      </div>
      <div>
        <p className="text-muted text-xs">Pontos</p>
        <p className="text-2xl font-semibold tabular-nums">{s.total.toLocaleString('pt-BR')}</p>
      </div>
      <div>
        <p className="text-muted text-xs">Neste mês</p>
        <p className="text-2xl font-semibold tabular-nums">{s.month.toLocaleString('pt-BR')}</p>
      </div>
      <div className="space-y-1 sm:col-span-3">
        <ProgressBar percent={progress} label="Progresso até o próximo nível" />
        <p className="text-muted text-xs">
          {s.next_level
            ? `Faltam ${(s.next_level.min_points - s.total).toLocaleString('pt-BR')} pontos para ${s.next_level.name}.`
            : 'Você está no nível mais alto.'}
        </p>
      </div>
    </div>
  );
}

function Achievements({ s }: { s: GamificationSummary }) {
  if (!s.achievements.length) return <p className="text-muted text-sm">Nenhuma conquista ativa.</p>;
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {s.achievements.map((a) => {
        const earned = a.earned_at !== null;
        return (
          <li
            key={a.code}
            className={cn(
              'border-border flex gap-3 rounded-lg border p-3',
              earned ? 'bg-success/5' : 'bg-surface',
            )}
          >
            {earned ? (
              <Medal className="text-success size-6 shrink-0" aria-hidden />
            ) : (
              <Lock className="text-muted size-6 shrink-0" aria-hidden />
            )}
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-medium">{a.name}</p>
              <p className="text-muted text-xs">{a.description}</p>
              {earned ? (
                <p className="text-success text-xs">Conquistada em {day(a.earned_at!)}</p>
              ) : (
                <>
                  <ProgressBar
                    percent={(a.progress / a.threshold) * 100}
                    label={`Progresso de ${a.name}`}
                  />
                  <p className="text-muted text-xs tabular-nums">
                    {a.progress} de {a.threshold}
                  </p>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function RankingSection({
  orgId,
  isSeller,
  isOwner,
  showInRanking,
}: {
  orgId: string;
  isSeller: boolean;
  isOwner: boolean;
  showInRanking: boolean;
}) {
  const ranking = useRanking(orgId);
  const visibility = useSetRankingVisibility(orgId);
  return (
    <Section
      title={`Ranking de ${ranking.data ? monthLabel(ranking.data.month) : 'o mês'}`}
      description={
        isSeller
          ? 'Pontos do mês entre vendedores. Lojas que não escolheram aparecer ficam anônimas.'
          : 'Pontos do mês entre fornecedores, pelo apelido de cada um.'
      }
    >
      {ranking.isPending ? (
        <PageLoader />
      ) : ranking.isError ? (
        <Alert tone="error">{gamificationErrorMessage(ranking.error)}</Alert>
      ) : ranking.data.top.length === 0 ? (
        <p className="text-muted text-sm">Ninguém pontuou neste mês ainda.</p>
      ) : (
        <div className="space-y-3">
          <ol className="divide-border -mx-5 divide-y">
            {ranking.data.top.map((r) => (
              <li
                key={`${r.position}-${r.name}-${r.points}`}
                className={cn(
                  'flex items-center gap-3 px-5 py-2 text-sm',
                  r.is_me && 'bg-brand/5 font-medium',
                )}
              >
                <span className="text-muted w-8 tabular-nums">{r.position}º</span>
                <span className="flex-1 truncate">
                  {r.name}
                  {r.is_me && ' (você)'}
                </span>
                <span className="tabular-nums">{r.points.toLocaleString('pt-BR')}</span>
              </li>
            ))}
          </ol>
          {ranking.data.me && !ranking.data.top.some((r) => r.is_me) && (
            <p className="text-sm">
              Sua posição: <strong>{ranking.data.me.position}º</strong> com{' '}
              {ranking.data.me.points.toLocaleString('pt-BR')} pontos.
            </p>
          )}
        </div>
      )}
      {isSeller && isOwner && (
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={showInRanking}
            disabled={visibility.isPending}
            onChange={(e) => visibility.mutate(e.target.checked)}
          />
          Mostrar o nome da minha loja no ranking
        </label>
      )}
      {visibility.isError && (
        <Alert tone="error" className="mt-2">
          {gamificationErrorMessage(visibility.error)}
        </Alert>
      )}
    </Section>
  );
}

export function AchievementsPage() {
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const summary = useGamificationSummary(orgId);
  const isSeller = active!.organization.kind === 'seller';

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Conquistas</h1>
        <p className="text-muted text-sm">
          Pontos por resultados reais da sua empresa: vendas, envios, avaliações e mais.
        </p>
      </div>
      {summary.isPending ? (
        <PageLoader />
      ) : summary.isError ? (
        <Alert tone="error">{gamificationErrorMessage(summary.error)}</Alert>
      ) : (
        <>
          <LevelCard s={summary.data} />
          <Section title="Conquistas" description="Marcos alcançados pela empresa.">
            <Achievements s={summary.data} />
          </Section>
          <RankingSection
            orgId={orgId}
            isSeller={isSeller}
            isOwner={active!.role === 'owner'}
            showInRanking={summary.data.show_in_ranking}
          />
          <Section title="Como ganhar pontos" description="Regras definidas pela equipe TheSigns.">
            <ul className="divide-border -mx-5 divide-y text-sm">
              {summary.data.rules.map((r) => (
                <li key={r.event} className="flex items-center justify-between gap-3 px-5 py-2">
                  <span>{r.label}</span>
                  <span className="text-muted tabular-nums">
                    {formatPoints(r.points)}
                    {r.daily_cap ? ` · até ${r.daily_cap}/dia` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Últimos pontos" description="Os 20 lançamentos mais recentes.">
            {summary.data.recent.length === 0 ? (
              <p className="text-muted text-sm">Nenhum ponto ainda.</p>
            ) : (
              <ul className="divide-border -mx-5 divide-y text-sm">
                {summary.data.recent.map((r, i) => (
                  <li
                    key={`${r.event}-${r.created_at}-${i}`}
                    className="flex items-center justify-between gap-3 px-5 py-2"
                  >
                    <span>
                      {r.label}
                      {r.points < 0 && ' (estorno)'}
                      <span className="text-muted block text-xs">{day(r.created_at)}</span>
                    </span>
                    <span
                      className={cn('tabular-nums', r.points < 0 ? 'text-danger' : 'text-success')}
                    >
                      {formatPoints(r.points)}
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
