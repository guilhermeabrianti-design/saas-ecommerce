import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import QRCode from 'qrcode';

/** QR Code gerado no navegador (nada sai para serviço externo), com download em PNG. */
export function QrCode({ value, fileName }: { value: string; fileName: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, { margin: 1, width: 512, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (!src) return null;
  return (
    <div className="flex items-center gap-4">
      <img
        src={src}
        alt={`QR Code de ${value}`}
        className="size-32 rounded-lg border border-black/10 bg-white p-1"
      />
      <a
        href={src}
        download={`${fileName}.png`}
        className="text-brand inline-flex items-center gap-2 text-sm font-medium hover:underline"
      >
        <Download className="size-4" aria-hidden />
        Baixar PNG
      </a>
    </div>
  );
}
