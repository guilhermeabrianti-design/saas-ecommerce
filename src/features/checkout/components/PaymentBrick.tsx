import { useEffect, useId, useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';

/**
 * Payment Brick do Mercado Pago: PIX, cartão (crédito/débito) e boleto.
 * Os dados do cartão são digitados dentro do iframe do Mercado Pago; aqui
 * só chega o token de uso único (nada de número de cartão no nosso código).
 */

const SDK_URL = 'https://sdk.mercadopago.com/js/v2';

interface BrickController {
  unmount: () => void;
}

interface MercadoPagoInstance {
  bricks: () => {
    create: (
      kind: 'payment',
      containerId: string,
      settings: Record<string, unknown>,
    ) => Promise<BrickController>;
  };
}

declare global {
  interface Window {
    MercadoPago?: new (publicKey: string, options?: { locale?: string }) => MercadoPagoInstance;
  }
}

let sdk: Promise<void> | null = null;

function loadSdk(): Promise<void> {
  if (window.MercadoPago) return Promise.resolve();
  sdk ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      sdk = null;
      script.remove();
      reject(new Error('mercadopago_sdk'));
    };
    document.head.appendChild(script);
  });
  return sdk;
}

export interface PaymentBrickProps {
  publicKey: string;
  amountCents: number;
  payerEmail: string;
  /** Resolve quando o servidor aceitou; rejeitar faz o Brick mostrar erro. */
  onSubmit: (formData: Record<string, unknown>) => Promise<void>;
}

export function PaymentBrick({ publicKey, amountCents, payerEmail, onSubmit }: PaymentBrickProps) {
  const containerId = `mp-brick-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  // O Brick guarda o callback da criação: a ref mantém sempre o mais recente.
  const submit = useRef(onSubmit);
  useEffect(() => {
    submit.current = onSubmit;
  }, [onSubmit]);

  useEffect(() => {
    let controller: BrickController | null = null;
    let cancelled = false;

    loadSdk()
      .then(() => {
        if (cancelled || !window.MercadoPago) return null;
        const mp = new window.MercadoPago(publicKey, { locale: 'pt-BR' });
        return mp.bricks().create('payment', containerId, {
          initialization: { amount: amountCents / 100, payer: { email: payerEmail } },
          customization: {
            paymentMethods: {
              bankTransfer: ['pix'],
              creditCard: 'all',
              debitCard: 'all',
              ticket: 'all',
              maxInstallments: 12,
            },
          },
          callbacks: {
            onReady: () => {
              if (!cancelled) setState('ready');
            },
            onSubmit: ({ formData }: { formData: Record<string, unknown> }) =>
              submit.current(formData),
            onError: (error: unknown) => {
              console.error('Payment Brick', error);
            },
          },
        });
      })
      .then((c) => {
        if (!c) return;
        if (cancelled) c.unmount();
        else controller = c;
      })
      .catch(() => {
        if (!cancelled) setState('failed');
      });

    return () => {
      cancelled = true;
      controller?.unmount();
    };
  }, [publicKey, amountCents, payerEmail, containerId]);

  return (
    <div>
      {state === 'loading' && <PageLoader />}
      {state === 'failed' && (
        <Alert tone="error">
          Não foi possível carregar o pagamento do Mercado Pago. Verifique a conexão ou desative
          bloqueadores de conteúdo e recarregue a página.
        </Alert>
      )}
      <div id={containerId} />
    </div>
  );
}
