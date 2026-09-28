import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { CopyField } from '@/components/ui/CopyField';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { TextField } from '@/components/ui/TextField';
import { useOrganization } from '@/features/organizations/organization-context';
import { orgKindLabels, orgPermissions } from '@/features/organizations/roles';
import { cn } from '@/utils/cn';
import { formatBRL } from '@/utils/money';
import {
  affiliateErrorMessage,
  describeProgram,
  isValidCode,
  normalizeCode,
  referralStatusLabels,
  referralUrl,
  type ReferralStatus,
  type ReferralSummary,
} from '../affiliates';
import { useApplyReferralCode, useReferralSummary } from '../api';
import { QrCode } from '../components/QrCode';

const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

const statusTone: Record<ReferralStatus, string> = {
  waiting: 'bg-brand/10 text-brand',
  rewarded: 'bg-success/10 text-success',
  expired: 'bg-surface-2 text-muted',
};

function ApplyCode({ orgId }: { orgId: string }) {
  const apply = useApplyReferralCode(orgId);
  const [code, setCode] = useState('');
  const valid = isValidCode(code);
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) apply.mutate(normalizeCode(code));
      }}
    >
      <div className="min-w-56 flex-1">
        <TextField
          label="Código de quem indicou"
          value={code}
          autoComplete="off"
          onChange={(e) => setCode(e.target.value)}
          error={apply.isError ? affiliateErrorMessage(apply.error) : undefined}
          hint="Vale nos primeiros 30 dias da organização e antes da primeira venda."
        />
      </div>
      <Button type="submit" variant="secondary" disabled={!valid} loading={apply.isPending}>
        Informar código
      </Button>
    </form>
  );
}

function ReferredBy({ orgId, s }: { orgId: string; s: ReferralSummary }) {
  if (s.referred_by) {
    return (
      <p className="text-sm">
        Indicada por <strong>{s.referred_by.name}</strong> em {day(s.referred_by.created_at)}.
      </p>
    );
  }
  if (s.can_apply) return <ApplyCode orgId={orgId} />;
  return <p className="text-muted text-sm">Nenhuma indicação registrada.</p>;
}

function Referrals({ s }: { s: ReferralSummary }) {
  if (!s.referrals.length) {
    return <p className="text-muted text-sm">Ninguém se cadastrou com o seu código ainda.</p>;
  }
  return (
    <ul className="divide-border -mx-5 divide-y">
      {s.referrals.map((r) => (
        <li
          key={`${r.name}-${r.created_at}`}
          className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm"
        >
          <div>
            <p className="font-medium">{r.name}</p>
            <p className="text-muted text-xs">
              {orgKindLabels[r.kind]} · desde {day(r.created_at)}
              {r.status === 'waiting' && ` · prazo até ${day(r.expires_at)}`}
            </p>
          </div>
          <div className="text-right">
            <span className={cn('rounded px-2 py-0.5 text-xs font-medium', statusTone[r.status])}>
              {referralStatusLabels[r.status]}
            </span>
            <p className="text-muted mt-1 text-xs tabular-nums">{formatBRL(r.reward_cents)}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Content({ orgId, s }: { orgId: string; s: ReferralSummary }) {
  const url = referralUrl(window.location.origin, s.code);
  return (
    <>
      <Section
        title="Seu link de indicação"
        description="Quem se cadastrar por ele (ou informar o seu código) fica vinculado a você."
      >
        {s.program.enabled ? (
          <div className="space-y-4">
            <p className="text-sm">{describeProgram(s.program, formatBRL)}</p>
            <CopyField value={url} label="Link de indicação" />
            <p className="text-muted text-sm">
              Código: <span className="text-fg font-mono">{s.code}</span>
            </p>
            <QrCode value={url} fileName={`indicacao-${s.code}`} />
            <p className="text-muted text-xs">
              A recompensa entra na Carteira como pendente e é liberada junto com a venda que a
              gerou. Se essa venda for estornada, a recompensa também é, e a próxima venda dentro do
              prazo passa a valer.
            </p>
          </div>
        ) : (
          <Alert tone="info">
            O programa de indicação está pausado pela equipe. Indicações já registradas continuam
            valendo.
          </Alert>
        )}
      </Section>

      <Section
        title="Suas indicações"
        description={`Recompensas creditadas até agora: ${formatBRL(s.earned_cents)}.`}
      >
        <Referrals s={s} />
      </Section>

      <Section title="Quem indicou você" description="Código informado na criação da organização.">
        <ReferredBy orgId={orgId} s={s} />
      </Section>
    </>
  );
}

export function ReferralsPage() {
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const allowed = orgPermissions.viewFinance(active!.role);
  const summary = useReferralSummary(orgId);

  if (!allowed) {
    return (
      <div className="mx-auto max-w-3xl">
        <Alert tone="info">
          Indicações são visíveis apenas para proprietários e administradores.
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Indique e ganhe</h1>
        <p className="text-muted text-sm">
          Convide vendedores e fornecedores para a TheSigns e ganhe quando eles venderem.
        </p>
      </div>
      {summary.isPending ? (
        <PageLoader />
      ) : summary.isError ? (
        <Alert tone="error">{affiliateErrorMessage(summary.error)}</Alert>
      ) : (
        <Content orgId={orgId} s={summary.data} />
      )}
    </div>
  );
}
