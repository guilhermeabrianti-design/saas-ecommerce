import { useRef, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { cn } from '@/utils/cn';
import { labelDownloadUrl, useShippingLabels, useUploadLabel, useVoidLabel } from '../api';
import {
  acceptFor,
  checkLabelFile,
  documentKindLabels,
  documentKinds,
  labelErrorMessage,
  type DocumentKind,
  type Shipment,
} from '../labels';

const when = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

function UploadForm({ shipment }: { shipment: Shipment }) {
  const upload = useUploadLabel(shipment);
  const input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<DocumentKind>('label');
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');

  const resetFile = () => {
    setFile(null);
    setProblem(null);
    if (input.current) input.current.value = '';
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!file) return;
        upload.mutate(
          { file, kind, carrier, trackingCode: tracking },
          {
            onSuccess: () => {
              resetFile();
              setCarrier('');
              setTracking('');
            },
          },
        );
      }}
    >
      {(problem || upload.isError) && (
        <Alert tone="error">{problem ?? labelErrorMessage(upload.error)}</Alert>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="Documento"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as DocumentKind);
            resetFile();
          }}
        >
          {documentKinds.map((k) => (
            <option key={k} value={k}>
              {documentKindLabels[k]}
            </option>
          ))}
        </Select>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">
            Arquivo ({kind === 'label' ? 'PDF, PNG ou JPG' : kind === 'invoice_pdf' ? 'PDF' : 'XML'}
            , até 5 MB)
          </span>
          <input
            ref={input}
            type="file"
            accept={acceptFor(kind)}
            className="block text-sm"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              const error = f ? checkLabelFile(f, kind) : null;
              setProblem(error);
              setFile(error ? null : f);
            }}
          />
        </label>
      </div>
      {kind === 'label' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="Transportadora (opcional)"
            value={carrier}
            onChange={(e) => setCarrier(e.target.value)}
          />
          <TextField
            label="Código de rastreio (opcional)"
            className="font-mono"
            value={tracking}
            onChange={(e) => setTracking(e.target.value)}
          />
        </div>
      )}
      <Button type="submit" variant="secondary" disabled={!file} loading={upload.isPending}>
        Anexar {documentKindLabels[kind].toLowerCase()}
      </Button>
    </form>
  );
}

/**
 * Etiquetas de um envio (pedido de fornecimento ou pedido de estoque
 * próprio): baixar, anexar e anular.
 */
export function LabelsSection({
  shipment,
  canUpload,
  emptyText,
}: {
  shipment: Shipment;
  canUpload: boolean;
  emptyText: string;
}) {
  const labels = useShippingLabels(shipment);
  const voidLabel = useVoidLabel(shipment);
  const [downloadError, setDownloadError] = useState(false);

  return (
    <div className="space-y-4">
      {labels.isError && <Alert tone="error">{labelErrorMessage(labels.error)}</Alert>}
      {downloadError && (
        <Alert tone="error">Não foi possível abrir o arquivo. Tente de novo.</Alert>
      )}
      {labels.data && labels.data.length === 0 && <p className="text-muted text-sm">{emptyText}</p>}
      {labels.data && labels.data.length > 0 && (
        <ul className="divide-border divide-y text-sm">
          {labels.data.map((l) => (
            <li
              key={l.id}
              className={cn('flex flex-wrap items-center gap-3 py-2', l.voided_at && 'opacity-60')}
            >
              <FileText className="text-muted size-4" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className={cn('truncate font-medium', l.voided_at && 'line-through')}>
                  {l.file_name}
                </p>
                <p className="text-muted text-xs">
                  {documentKindLabels[l.kind]}
                  {l.source === 'mercadolivre' && ' · Mercado Livre'}
                  {' · '}
                  {when(l.created_at)}
                  {l.carrier && ` · ${l.carrier}`}
                  {l.tracking_code && (
                    <>
                      {' · '}
                      <span className="font-mono">{l.tracking_code}</span>
                    </>
                  )}
                  {l.voided_at && ' · anulada'}
                </p>
              </div>
              {!l.voided_at && (
                <>
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      setDownloadError(false);
                      try {
                        window.open(await labelDownloadUrl(l.storage_path), '_blank', 'noopener');
                      } catch {
                        setDownloadError(true);
                      }
                    }}
                  >
                    <Download className="size-4" aria-hidden />
                    Baixar
                  </Button>
                  {canUpload && (
                    <ConfirmButton
                      confirmLabel="Anular"
                      loading={voidLabel.isPending && voidLabel.variables === l.id}
                      onConfirm={() => voidLabel.mutate(l.id)}
                    >
                      Anular
                    </ConfirmButton>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {canUpload && <UploadForm shipment={shipment} />}
    </div>
  );
}
