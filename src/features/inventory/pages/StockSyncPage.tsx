import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeft, Download, FileSpreadsheet, RefreshCw } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { TextField } from '@/components/ui/TextField';
import { useOrganization } from '@/features/organizations/organization-context';
import { orgPermissions } from '@/features/organizations/roles';
import {
  describeSummary,
  parseStockCsv,
  stockTemplateCsv,
  type ParsedStockCsv,
  type StockSyncSummary,
} from '../stock-sync';
import {
  fetchStockTemplateItems,
  useBulkSetStock,
  useConnectBling,
  useConnectTiny,
  useDisconnectErp,
  useErpConnections,
  useSyncErp,
  type ErpConnection,
} from '../stock-sync-api';

const when = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

const returnMessages: Record<string, { tone: 'success' | 'error' | 'info'; text: string }> = {
  conectado: { tone: 'success', text: 'Bling conectado. A primeira sincronização já foi feita.' },
  cancelado: { tone: 'info', text: 'Conexão com o Bling cancelada.' },
  expirado: { tone: 'error', text: 'A autorização demorou demais. Tente conectar de novo.' },
  erro: { tone: 'error', text: 'Não foi possível conectar o Bling. Tente de novo.' },
};

function SummaryView({ summary }: { summary: StockSyncSummary }) {
  return (
    <div className="space-y-2 text-sm">
      <Alert tone={summary.clamped.length ? 'error' : 'success'}>{describeSummary(summary)}</Alert>
      {summary.unknown.length > 0 && (
        <p className="text-muted">
          Não encontrados aqui: <span className="font-mono">{summary.unknown.join(', ')}</span>
          {summary.unknown_count > summary.unknown.length && ' …'}
        </p>
      )}
      {summary.clamped.length > 0 && (
        <p className="text-muted">
          Ficaram no mínimo reservado por pedidos em aberto:{' '}
          <span className="font-mono">{summary.clamped.join(', ')}</span>
        </p>
      )}
      {summary.invalid.length > 0 && (
        <p className="text-muted">
          Quantidade inválida: <span className="font-mono">{summary.invalid.join(', ')}</span>
        </p>
      )}
    </div>
  );
}

function SpreadsheetSection({ orgId }: { orgId: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<ParsedStockCsv | null>(null);
  const [fileName, setFileName] = useState('');
  const [templateError, setTemplateError] = useState(false);
  const bulk = useBulkSetStock(orgId);

  return (
    <Section
      title="Atualizar por planilha"
      description="Envie um CSV com duas colunas: SKU e quantidade em estoque. Vale para o estoque próprio; produtos importados do catálogo usam o estoque do fornecedor."
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="border-border hover:bg-surface-2 inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm font-medium">
            <FileSpreadsheet className="size-4" aria-hidden />
            Escolher planilha (.csv)
            <input
              ref={input}
              type="file"
              accept=".csv,text/csv,text/plain"
              className="sr-only"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                bulk.reset();
                if (!file) return;
                setFileName(file.name);
                setParsed(
                  file.size > 2 * 1024 * 1024
                    ? { rows: [], skipped: [], error: 'Arquivo acima de 2 MB.' }
                    : parseStockCsv(await file.text()),
                );
              }}
            />
          </label>
          <Button
            variant="ghost"
            onClick={async () => {
              setTemplateError(false);
              try {
                const csv = stockTemplateCsv(await fetchStockTemplateItems(orgId));
                const url = URL.createObjectURL(
                  new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }),
                );
                const a = document.createElement('a');
                a.href = url;
                a.download = 'estoque.csv';
                a.click();
                URL.revokeObjectURL(url);
              } catch {
                setTemplateError(true);
              }
            }}
          >
            <Download className="size-4" aria-hidden />
            Baixar modelo com meu estoque
          </Button>
        </div>
        {templateError && <Alert tone="error">Não foi possível gerar o modelo.</Alert>}

        {parsed?.error && <Alert tone="error">{parsed.error}</Alert>}
        {parsed && !parsed.error && (
          <div className="space-y-3">
            <p className="text-sm">
              <strong>{fileName}</strong>: {parsed.rows.length} linha(s) para atualizar
              {parsed.skipped.length > 0 &&
                ` · ${parsed.skipped.length} ignorada(s) (linhas ${parsed.skipped.slice(0, 10).join(', ')}${parsed.skipped.length > 10 ? '…' : ''})`}
            </p>
            <table className="text-sm">
              <thead>
                <tr className="text-muted text-left text-xs">
                  <th className="pr-6 font-medium">SKU</th>
                  <th className="font-medium">Quantidade</th>
                </tr>
              </thead>
              <tbody>
                {parsed.rows.slice(0, 5).map((r, i) => (
                  <tr key={i}>
                    <td className="pr-6 font-mono">{r.sku}</td>
                    <td className="tabular-nums">{r.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {bulk.isError && (
              <Alert tone="error">Não foi possível atualizar. Tente de novo em instantes.</Alert>
            )}
            {bulk.data ? (
              <SummaryView summary={bulk.data} />
            ) : (
              <Button loading={bulk.isPending} onClick={() => bulk.mutate(parsed.rows)}>
                Atualizar estoque
              </Button>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

function ConnectionCard({ orgId, connection }: { orgId: string; connection: ErpConnection }) {
  const sync = useSyncErp(orgId);
  const disconnect = useDisconnectErp(orgId);
  const s = connection.last_sync_summary;
  const lastError = s && typeof s.error === 'string' ? s.error : null;

  return (
    <div className="space-y-3 text-sm">
      <p>
        <strong>{connection.name}</strong> conectado.{' '}
        {connection.last_sync_at ? (
          <span className="text-muted">Última sincronização: {when(connection.last_sync_at)}.</span>
        ) : (
          <span className="text-muted">Ainda não sincronizado.</span>
        )}
      </p>
      {lastError && <Alert tone="error">Última tentativa falhou: {lastError}</Alert>}
      {s && !lastError && 'updated' in s && (
        <SummaryView summary={s as unknown as StockSyncSummary} />
      )}
      {sync.isError && <Alert tone="error">{(sync.error as Error).message}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          loading={sync.isPending}
          onClick={() => sync.mutate(connection.id)}
        >
          <RefreshCw className="size-4" aria-hidden />
          Sincronizar agora
        </Button>
        <ConfirmButton
          confirmLabel="Desconectar"
          loading={disconnect.isPending}
          onConfirm={() => disconnect.mutate(connection.id)}
        >
          Desconectar
        </ConfirmButton>
      </div>
    </div>
  );
}

function BlingSection({ orgId, connection }: { orgId: string; connection?: ErpConnection }) {
  const connect = useConnectBling(orgId);
  return (
    <Section
      title="Bling"
      description="O saldo do Bling passa a valer aqui: vendeu em outra plataforma ligada ao Bling, o estoque daqui acompanha. Os SKUs precisam ser iguais nos dois."
    >
      {connection ? (
        <ConnectionCard orgId={orgId} connection={connection} />
      ) : (
        <div className="space-y-3">
          {connect.isError && <Alert tone="error">{(connect.error as Error).message}</Alert>}
          <Button loading={connect.isPending} onClick={() => connect.mutate('Bling')}>
            Conectar Bling
          </Button>
          <p className="text-muted text-xs">Você autoriza no próprio Bling e volta para cá.</p>
        </div>
      )}
    </Section>
  );
}

function TinySection({ orgId, connection }: { orgId: string; connection?: ErpConnection }) {
  const connect = useConnectTiny(orgId);
  const [token, setToken] = useState('');
  const valid = /^[A-Za-z0-9]{20,128}$/.test(token.trim());
  return (
    <Section
      title="Tiny (Olist ERP)"
      description="O saldo do Tiny passa a valer aqui, com os mesmos SKUs. No Tiny, instale a extensão “API para estoque em tempo real” e copie o token em Configurações › Token API."
    >
      {connection ? (
        <ConnectionCard orgId={orgId} connection={connection} />
      ) : (
        <form
          noValidate
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) connect.mutate({ name: 'Tiny', token: token.trim() });
          }}
        >
          {connect.isError && <Alert tone="error">{(connect.error as Error).message}</Alert>}
          <TextField
            label="Token da API do Tiny"
            className="font-mono"
            autoComplete="off"
            value={token}
            error={token && !valid ? 'Token inválido (letras e números).' : undefined}
            hint="Fica guardado criptografado e nunca é exibido de novo."
            onChange={(e) => setToken(e.target.value)}
          />
          <Button type="submit" loading={connect.isPending} disabled={!valid}>
            Conectar Tiny
          </Button>
        </form>
      )}
    </Section>
  );
}

/**
 * Estoque sincronizado (Fase 36): planilha e ERPs, para o estoque daqui
 * acompanhar as vendas feitas em outros lugares sem ajuste manual.
 */
export function StockSyncPage() {
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const [params] = useSearchParams();
  const ret = returnMessages[params.get('erp') ?? ''];
  const erp = useErpConnections(orgId);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        to="/produtos"
        className="text-muted hover:text-fg inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Produtos
      </Link>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sincronizar estoque</h1>
        <p className="text-muted mt-1 text-sm">
          Vendeu em outro lugar? Atualize por planilha ou conecte seu ERP e o estoque daqui
          acompanha sozinho — e segue para o Mercado Livre.
        </p>
      </div>

      {!orgPermissions.editCatalog(active!.role) ? (
        <Alert tone="info">Somente proprietários e administradores atualizam o estoque.</Alert>
      ) : (
        <>
          {ret && <Alert tone={ret.tone}>{ret.text}</Alert>}
          <SpreadsheetSection orgId={orgId} />
          {erp.isPending ? (
            <PageLoader />
          ) : erp.isError ? (
            <Alert tone="error">Não foi possível carregar as conexões.</Alert>
          ) : (
            <>
              <BlingSection
                orgId={orgId}
                connection={erp.data.find((c) => c.provider === 'bling')}
              />
              <TinySection orgId={orgId} connection={erp.data.find((c) => c.provider === 'tiny')} />
            </>
          )}
        </>
      )}
    </div>
  );
}
