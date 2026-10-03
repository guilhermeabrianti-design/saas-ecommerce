import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Eye, PackagePlus } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Section } from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import { useOrganization } from '@/features/organizations/organization-context';
import { cn } from '@/utils/cn';
import { formatBRL } from '@/utils/money';
import { useBuySponsorship, useSponsorshipOverview, useSponsorshipReturn } from '../api';
import {
  campaignState,
  durationLabel,
  placementLabels,
  sponsorshipErrorMessage,
  type SponsorshipOverview,
} from '../sponsorships';

function BuyForm({ o }: { o: SponsorshipOverview }) {
  const buy = useBuySponsorship();
  const [listingId, setListingId] = useState(o.listings[0]?.id ?? '');
  const [packageId, setPackageId] = useState('');

  if (o.packages.length === 0) {
    return (
      <p className="text-muted text-sm">
        Nenhum pacote de patrocínio à venda no momento. A equipe TheSigns avisa quando houver.
      </p>
    );
  }
  if (o.listings.length === 0) {
    return (
      <p className="text-muted text-sm">
        Publique um produto no catálogo (ativo e visível) para patrociná-lo.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <Select label="Anúncio" value={listingId} onChange={(e) => setListingId(e.target.value)}>
        {o.listings.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </Select>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">Pacote</legend>
        {o.packages.map((p) => (
          <label
            key={p.id}
            className={cn(
              'border-border flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3.5 py-3 text-sm',
              packageId === p.id && 'border-brand ring-brand/30 ring-2',
              p.sold_out && 'cursor-not-allowed opacity-60',
            )}
          >
            <span className="flex items-center gap-3">
              <input
                type="radio"
                name="package"
                className="accent-brand size-4"
                value={p.id}
                disabled={p.sold_out}
                checked={packageId === p.id}
                onChange={() => setPackageId(p.id)}
              />
              <span>
                <span className="font-medium">{p.name}</span>
                <span className="text-muted block text-xs">
                  {placementLabels[p.placement]} · {durationLabel(p.duration_days)}
                  {p.sold_out && ' · esgotado'}
                </span>
              </span>
            </span>
            <span className="font-semibold tabular-nums">{formatBRL(p.price_cents)}</span>
          </label>
        ))}
      </fieldset>
      {buy.isError && <Alert tone="error">{sponsorshipErrorMessage(buy.error)}</Alert>}
      <Button
        disabled={!packageId || !listingId}
        loading={buy.isPending}
        onClick={() =>
          buy.mutate({ listingId, packageId }, { onSuccess: (url) => window.location.assign(url) })
        }
      >
        Pagar e colocar no ar
      </Button>
      <p className="text-muted text-xs">
        Pagamento único pelo Mercado Pago (PIX, cartão ou boleto). A campanha começa quando o
        pagamento for aprovado e dura os dias do pacote.
      </p>
    </div>
  );
}

function Campaigns({ o }: { o: SponsorshipOverview }) {
  if (o.campaigns.length === 0)
    return <p className="text-muted text-sm">Nenhuma campanha ainda.</p>;
  return (
    <ul className="divide-border -mx-5 divide-y text-sm">
      {o.campaigns.map((c) => (
        <li key={c.id} className="space-y-1 px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium">{c.listing_name}</p>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-xs font-medium',
                c.live ? 'bg-success/10 text-success' : 'bg-surface-2 text-muted',
              )}
            >
              {campaignState(c)}
            </span>
          </div>
          <p className="text-muted text-xs">
            {placementLabels[c.placement]} · {c.package_name} · {durationLabel(c.duration_days)} ·{' '}
            {formatBRL(c.price_cents)}
          </p>
          {c.starts_at && (
            <p className="flex flex-wrap gap-4 text-xs">
              <span className="flex items-center gap-1">
                <Eye className="size-3.5" aria-hidden />
                {c.views} {c.views === 1 ? 'loja abriu' : 'lojas abriram'}
              </span>
              <span className="flex items-center gap-1">
                <PackagePlus className="size-3.5" aria-hidden />
                {c.imports} {c.imports === 1 ? 'loja importou' : 'lojas importaram'}
              </span>
            </p>
          )}
          {c.status === 'pending' && c.checkout_url && o.can_manage && (
            <a className="text-brand text-xs underline" href={c.checkout_url}>
              Continuar pagamento
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

export function SponsorshipsPage() {
  const { active } = useOrganization();
  const orgId = active!.organization.id;
  const overview = useSponsorshipOverview(orgId);
  const back = useSponsorshipReturn(orgId);
  const [params, setParams] = useSearchParams();
  const paymentId = params.get('payment_id') ?? params.get('collection_id');
  const handled = useRef(false);

  // Voltou do Mercado Pago: relê o pagamento sem esperar a notificação.
  useEffect(() => {
    if (!paymentId || handled.current) return;
    handled.current = true;
    if (/^\d{1,30}$/.test(paymentId)) {
      back.mutate(paymentId, { onSettled: () => setParams({}, { replace: true }) });
    } else {
      setParams({}, { replace: true });
    }
  }, [paymentId, back, setParams]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Patrocínios</h1>
        <p className="text-muted text-sm">
          Coloque um anúncio no topo do Catálogo ou da Central de Vendas, com selo Patrocinado.
        </p>
      </div>
      {back.isPending && <Alert tone="info">Conferindo o pagamento no Mercado Pago…</Alert>}
      {overview.isPending ? (
        <PageLoader />
      ) : overview.isError ? (
        <Alert tone="error">{sponsorshipErrorMessage(overview.error)}</Alert>
      ) : (
        <>
          {overview.data.can_manage ? (
            <Section title="Novo patrocínio" description="Escolha o anúncio e o pacote.">
              <BuyForm o={overview.data} />
            </Section>
          ) : (
            <p className="text-muted text-sm">
              Só proprietário e administradores compram patrocínio.
            </p>
          )}
          <Section
            title="Campanhas"
            description="Resultados reais: lojas que abriram o anúncio e que importaram o produto durante a campanha."
          >
            <Campaigns o={overview.data} />
          </Section>
        </>
      )}
    </div>
  );
}
