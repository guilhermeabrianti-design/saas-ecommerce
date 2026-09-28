import { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { describeAttributes } from '@/features/products/variants';
import { RatingBadge } from '@/features/reviews/components/Stars';
import { currentAttribution } from '@/features/affiliates/affiliates';
import { isSupabaseConfigured } from '@/lib/supabase';
import { UFS } from '@/utils/br';
import { formatBRL } from '@/utils/money';
import { useCheckoutOffer, usePay } from '../api';
import {
  CheckoutError,
  buyerSchema,
  checkoutErrorMessage,
  emptyBuyer,
  maxQuantity,
  selection,
  toBuyerPayload,
  toPaymentPayload,
  type BuyerValues,
  type CheckoutOffer,
} from '../checkout';
import { PaymentBrick } from '../components/PaymentBrick';

function Gallery({ images, name }: { images: string[]; name: string }) {
  const [current, setCurrent] = useState(0);
  if (!images.length) return null;
  return (
    <div className="space-y-2">
      <img
        src={images[current]}
        alt={name}
        className="border-border bg-surface-2 aspect-square w-full rounded-xl border object-contain"
      />
      {images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto">
          {images.map((src, i) => (
            <button
              key={src}
              type="button"
              onClick={() => setCurrent(i)}
              aria-label={`Foto ${i + 1}`}
              aria-current={i === current || undefined}
              className="border-border aria-[current=true]:border-brand size-16 shrink-0 overflow-hidden rounded-lg border-2"
            >
              <img src={src} alt="" className="size-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface Locked {
  buyer: BuyerValues;
  variantId: string | null;
  quantity: number;
  totalCents: number;
}

function BuyerForm({
  defaultValues,
  disabled,
  onContinue,
}: {
  defaultValues: BuyerValues;
  disabled: boolean;
  onContinue: (values: BuyerValues) => void;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<BuyerValues>({ resolver: zodResolver(buyerSchema), defaultValues });

  return (
    <form onSubmit={handleSubmit(onContinue)} className="space-y-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <TextField
            label="Nome completo"
            autoComplete="name"
            {...register('customer_name')}
            error={errors.customer_name?.message}
          />
        </div>
        <TextField
          label="E-mail"
          type="email"
          autoComplete="email"
          {...register('customer_email')}
          error={errors.customer_email?.message}
        />
        <TextField
          label="Celular"
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          {...register('customer_phone')}
          error={errors.customer_phone?.message}
        />
        <TextField
          label="CPF"
          inputMode="numeric"
          {...register('customer_document')}
          error={errors.customer_document?.message}
        />
        <TextField
          label="CEP"
          inputMode="numeric"
          autoComplete="postal-code"
          {...register('ship_postal_code')}
          error={errors.ship_postal_code?.message}
        />
        <div className="sm:col-span-2">
          <TextField
            label="Rua"
            autoComplete="address-line1"
            {...register('ship_street')}
            error={errors.ship_street?.message}
          />
        </div>
        <TextField
          label="Número"
          {...register('ship_number')}
          error={errors.ship_number?.message}
        />
        <TextField
          label="Complemento (opcional)"
          autoComplete="address-line2"
          {...register('ship_complement')}
          error={errors.ship_complement?.message}
        />
        <TextField
          label="Bairro"
          {...register('ship_district')}
          error={errors.ship_district?.message}
        />
        <TextField
          label="Cidade"
          autoComplete="address-level2"
          {...register('ship_city')}
          error={errors.ship_city?.message}
        />
        <Select label="Estado" {...register('ship_state')}>
          {UFS.map((uf) => (
            <option key={uf} value={uf}>
              {uf}
            </option>
          ))}
        </Select>
      </div>
      <Button type="submit" disabled={disabled} className="w-full sm:w-auto">
        Continuar para o pagamento
      </Button>
    </form>
  );
}

function Checkout({ data }: { data: CheckoutOffer }) {
  const { offer, payments } = data;
  const navigate = useNavigate();
  const { mutateAsync: payAsync, isPending: paying } = usePay();
  const [payError, setPayError] = useState<unknown>(null);
  const [variantId, setVariantId] = useState<string | null>(offer.variants[0]?.variant_id ?? null);
  const [quantity, setQuantity] = useState(1);
  const [locked, setLocked] = useState<Locked | null>(null);
  const [buyer, setBuyer] = useState<BuyerValues>(emptyBuyer);

  const chosen = selection(offer, variantId);
  const max = maxQuantity(chosen.available);
  const qty = Math.min(quantity, Math.max(max, 1));
  const unavailable = chosen.price_cents == null || max === 0;

  const submit = useCallback(
    async (formData: Record<string, unknown>) => {
      if (!locked) return;
      setPayError(null);
      try {
        const result = await payAsync({
          product_id: offer.product_id,
          variant_id: locked.variantId,
          quantity: locked.quantity,
          // Cada envio do Brick é uma tentativa nova (cartão recusado → outra tentativa).
          request_id: crypto.randomUUID(),
          buyer: toBuyerPayload(locked.buyer),
          payment: toPaymentPayload(formData),
          attribution: currentAttribution(),
        });
        // Cartão recusado: fica aqui para tentar outro cartão ou meio.
        if (result.status === 'rejected') throw new CheckoutError('payment_rejected');
        navigate(`/c/pedido/${result.token}`, { replace: true });
      } catch (e) {
        setPayError(e);
        throw e;
      }
    },
    [locked, offer.product_id, payAsync, navigate],
  );

  return (
    <div className="grid gap-8 md:grid-cols-2">
      <div className="space-y-4">
        <Gallery images={offer.images} name={offer.name} />
        <div>
          <p className="text-muted text-sm">Vendido por {offer.store_name}</p>
          <RatingBadge rating={offer.rating} />
          <h1 className="text-2xl font-semibold tracking-tight">{offer.name}</h1>
          {offer.brand && <p className="text-muted text-sm">{offer.brand}</p>}
        </div>
        {offer.description && (
          <p className="text-muted text-sm whitespace-pre-line">{offer.description}</p>
        )}
      </div>

      <div className="space-y-6">
        {!locked ? (
          <>
            <Section title="Sua compra" description="Escolha a opção e a quantidade.">
              <div className="space-y-4">
                {offer.has_variants && (
                  <Select
                    label="Opção"
                    value={variantId ?? ''}
                    onChange={(e) => setVariantId(e.target.value)}
                  >
                    {offer.variants.map((v) => (
                      <option key={v.variant_id} value={v.variant_id} disabled={v.available === 0}>
                        {describeAttributes(v.attributes)} — {formatBRL(v.price_cents)}
                        {v.available === 0 ? ' (esgotado)' : ''}
                      </option>
                    ))}
                  </Select>
                )}
                <Select
                  label="Quantidade"
                  value={String(qty)}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                  disabled={unavailable}
                >
                  {Array.from({ length: Math.max(max, 1) }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
                <div className="flex items-baseline justify-between">
                  <span className="text-muted text-sm">Total (frete incluso)</span>
                  <span className="text-xl font-semibold tabular-nums">
                    {chosen.price_cents == null ? '—' : formatBRL(chosen.price_cents * qty)}
                  </span>
                </div>
                {unavailable && <Alert tone="info">Esgotado no momento.</Alert>}
              </div>
            </Section>

            <Section
              title="Entrega e contato"
              description="Para onde enviar e como falar com você."
            >
              {!payments.configured && (
                <Alert tone="info" className="mb-4">
                  Pagamentos ainda não configurados nesta loja. Tente mais tarde.
                </Alert>
              )}
              <BuyerForm
                defaultValues={buyer}
                disabled={unavailable || !payments.configured}
                onContinue={(values) => {
                  setBuyer(values);
                  setPayError(null);
                  setLocked({
                    buyer: values,
                    variantId: offer.has_variants ? variantId : null,
                    quantity: qty,
                    totalCents: (chosen.price_cents ?? 0) * qty,
                  });
                }}
              />
            </Section>
          </>
        ) : (
          <Section title="Pagamento" description="Pix, cartão ou boleto, pelo Mercado Pago.">
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3 text-sm">
                <div>
                  <p className="font-medium">
                    {locked.quantity} × {offer.name}
                  </p>
                  <p className="text-muted">
                    Entrega para {locked.buyer.customer_name} · {locked.buyer.ship_city}/
                    {locked.buyer.ship_state}
                  </p>
                </div>
                <span className="font-semibold tabular-nums">{formatBRL(locked.totalCents)}</span>
              </div>
              <Button variant="ghost" onClick={() => setLocked(null)} disabled={paying}>
                <ArrowLeft className="size-4" aria-hidden />
                Alterar dados
              </Button>
              {payError != null && <Alert tone="error">{checkoutErrorMessage(payError)}</Alert>}
              {payments.configured && (
                <PaymentBrick
                  publicKey={payments.public_key}
                  amountCents={locked.totalCents}
                  payerEmail={locked.buyer.customer_email}
                  onSubmit={submit}
                />
              )}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

export function CheckoutPage() {
  const { productId = '' } = useParams();
  const offer = useCheckoutOffer(productId);

  if (!isSupabaseConfigured) {
    return <Alert tone="info">Loja não configurada neste ambiente.</Alert>;
  }
  if (offer.isPending) return <PageLoader />;
  if (offer.isError) return <Alert tone="error">{checkoutErrorMessage(offer.error)}</Alert>;
  if (!offer.data) {
    return (
      <Alert tone="info">
        Este produto não está disponível para compra. Confira o link com quem o enviou.
      </Alert>
    );
  }
  return <Checkout data={offer.data} />;
}
