import { useQuery } from '@tanstack/react-query';
import { env } from '@/lib/env';
import { StatusDot, type StatusTone } from '@/components/ui/StatusDot';

async function checkAuthHealth(): Promise<boolean> {
  if (!env.supabase) return false;
  // GoTrue health endpoint; requires the public anon key only.
  const res = await fetch(`${env.supabase.url}/auth/v1/health`, {
    headers: { apikey: env.supabase.anonKey },
  });
  return res.ok;
}

interface Row {
  label: string;
  detail: string;
  tone: StatusTone;
}

export function SystemStatusPage() {
  const health = useQuery({
    queryKey: ['system', 'supabase-auth-health'],
    queryFn: checkAuthHealth,
    enabled: env.supabase !== null,
    retry: false,
  });

  const supabaseRow: Row = !env.supabase
    ? {
        label: 'Supabase',
        detail: 'Não configurado — defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY em .env.local',
        tone: 'idle',
      }
    : health.isPending
      ? { label: 'Supabase', detail: 'Verificando conexão…', tone: 'warn' }
      : health.data
        ? { label: 'Supabase', detail: `Conectado a ${new URL(env.supabase.url).host}`, tone: 'ok' }
        : { label: 'Supabase', detail: 'Configurado, mas inacessível', tone: 'error' };

  const rows: Row[] = [{ label: 'Ambiente', detail: env.appEnv, tone: 'ok' }, supabaseRow];

  return (
    <div className="mx-auto max-w-3xl">
      <p className="text-brand font-mono text-xs font-medium tracking-widest uppercase">
        Fase 2 · Autenticação
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Status do sistema</h1>
      <p className="text-muted mt-1 text-sm">
        Diagnóstico da configuração do ambiente. Módulos são habilitados conforme cada fase é
        concluída e validada.
      </p>

      <ul className="border-border bg-surface divide-border mt-8 divide-y rounded-xl border">
        {rows.map((row) => (
          <li key={row.label} className="flex items-start gap-3 px-5 py-4">
            <StatusDot tone={row.tone} className="mt-1.5" />
            <div className="min-w-0">
              <p className="text-sm font-medium">{row.label}</p>
              <p className="text-muted text-sm break-words">{row.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
