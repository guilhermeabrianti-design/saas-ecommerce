import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/PageLoader';
import { Select } from '@/components/ui/Select';
import { StatusDot } from '@/components/ui/StatusDot';
import { TextField } from '@/components/ui/TextField';
import type { Product } from '@/features/products/api';
import { useVariants } from '@/features/products/variants';
import { providerLabels, type Provider } from '@/features/integrations/schemas';
import {
  PublishRequestError,
  useMarketplaceCategory,
  usePublish,
  useSaveListingAttributes,
} from '../api';
import type { ChannelConfig } from '../channels';
import { channelErrorMessage } from '../channels';
import {
  attributeDraft,
  attributesPayload,
  missingRequired,
  inMarketplace,
  publishStatusInfo,
  variantKeys,
  variationMapDraft,
  type AttributeDraft,
  type MlAttribute,
  type MlCategory,
} from '../ml-publish';

const OPTIONAL_SHOWN = 12;

function AttributeField({
  attr,
  value,
  disabled,
  onChange,
}: {
  attr: MlAttribute;
  value: AttributeDraft[string] | undefined;
  disabled: boolean;
  onChange: (v: AttributeDraft[string]) => void;
}) {
  const label = `${attr.name}${attr.required ? ' *' : ''}`;
  if (attr.values.length > 0 && attr.value_type !== 'number_unit') {
    return (
      <Select
        label={label}
        value={value?.value_id ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value ? { value_id: e.target.value } : {})}
      >
        <option value="">{attr.required ? 'Escolha…' : 'Não informar'}</option>
        {attr.values.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </Select>
    );
  }
  const unit = attr.units[0]?.name;
  return (
    <TextField
      label={label}
      value={value?.value_name ?? ''}
      disabled={disabled}
      maxLength={255}
      placeholder={unit ? `Ex.: 10 ${unit}` : attr.hint || undefined}
      onChange={(e) => onChange({ value_name: e.target.value })}
    />
  );
}

function AttributesForm({
  provider,
  product,
  saved,
  category,
  keys,
  canEdit,
}: {
  provider: Provider;
  product: Product;
  saved: ChannelConfig;
  category: MlCategory;
  keys: string[];
  canEdit: boolean;
}) {
  const save = useSaveListingAttributes(provider, product.id);
  // Só o Mercado Livre associa as características das variações a atributos.
  const mapsVariations = provider === 'mercadolivre';
  const [draft, setDraft] = useState<AttributeDraft>(() => attributeDraft(saved.attributes));
  const [map, setMap] = useState<Record<string, string>>(() =>
    variationMapDraft(keys, category.attributes, saved.variation_map),
  );
  const [showAll, setShowAll] = useState(false);
  const required = category.attributes.filter((a) => a.required);
  const optional = category.attributes.filter((a) => !a.required);
  const shownOptional = showAll ? optional : optional.slice(0, OPTIONAL_SHOWN);
  const variationOptions = category.attributes.filter((a) => a.variation);
  const missing = missingRequired(category.attributes, draft, product, map);
  const unmapped = mapsVariations ? keys.filter((k) => !map[k]) : [];

  const field = (a: MlAttribute) => (
    <AttributeField
      key={a.id}
      attr={a}
      value={draft[a.id]}
      disabled={!canEdit}
      onChange={(v) => setDraft((d) => ({ ...d, [a.id]: v }))}
    />
  );

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          attributes: attributesPayload(draft, category.attributes),
          variationMap: map,
        });
      }}
    >
      {save.isError && <Alert tone="error">{channelErrorMessage(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">Atributos salvos.</Alert>}

      {mapsVariations && keys.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Variações</p>
          <p className="text-muted text-xs">
            Diga a qual atributo do Mercado Livre corresponde cada característica das suas
            variações.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {keys.map((k) => (
              <Select
                key={k}
                label={k}
                value={map[k] ?? ''}
                disabled={!canEdit}
                onChange={(e) =>
                  setMap((m) => {
                    const next = { ...m };
                    if (e.target.value) next[k] = e.target.value;
                    else delete next[k];
                    return next;
                  })
                }
              >
                <option value="">Escolha…</option>
                {variationOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            ))}
          </div>
          {variationOptions.length === 0 && (
            <Alert tone="info">Esta categoria do Mercado Livre não aceita variações.</Alert>
          )}
        </div>
      )}

      {required.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Obrigatórios</p>
          {mapsVariations && (
            <p className="text-muted text-xs">
              Marca e código de barras do produto entram sozinhos quando preenchidos no cadastro.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">{required.map(field)}</div>
        </div>
      )}
      {optional.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Opcionais (ajudam o anúncio a aparecer nas buscas)</p>
          <div className="grid gap-4 sm:grid-cols-2">{shownOptional.map(field)}</div>
          {optional.length > OPTIONAL_SHOWN && (
            <Button variant="secondary" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Mostrar menos' : `Mostrar todos (${optional.length})`}
            </Button>
          )}
        </div>
      )}

      {(missing.length > 0 || unmapped.length > 0) && (
        <Alert tone="info">
          {missing.length > 0 && <>Falta preencher: {missing.map((a) => a.name).join(', ')}. </>}
          {unmapped.length > 0 && <>Falta associar: {unmapped.join(', ')}.</>}
        </Alert>
      )}
      {canEdit && (
        <Button type="submit" variant="secondary" loading={save.isPending}>
          Salvar atributos
        </Button>
      )}
    </form>
  );
}

/** Regras de variação de cada marketplace, para o rodapé. */
const variationNote: Record<Provider, string> = {
  mercadolivre: 'Com variações, todas saem pelo preço deste canal (regra do Mercado Livre).',
  shopee:
    'Com variações (até 2 características, ex.: Cor e Tamanho), todas saem pelo preço deste canal. Variação nova num anúncio já publicado precisa ser criada na Shopee. A Shopee exige o peso do produto.',
  tiktok:
    'Com variações (até 3 características), todas saem pelo preço deste canal. A TikTok Shop exige o peso do produto.',
};

/**
 * Publicar no marketplace (Mercado Livre, Fase 37; Shopee e TikTok Shop,
 * Fase 44): atributos da categoria, mapa das variações (só Mercado Livre)
 * e os botões de publicar/atualizar, pausar e reativar. O que aparece aqui
 * é o que ficou gravado no banco pela última execução.
 */
export function MarketplacePublish({
  provider,
  product,
  saved,
  canEdit,
}: {
  provider: Provider;
  product: Product;
  saved: ChannelConfig;
  canEdit: boolean;
}) {
  const category = useMarketplaceCategory(
    provider,
    product.organization_id,
    saved.marketplace_category,
  );
  const variants = useVariants(product.organization_id, product.id);
  const publish = usePublish(provider, product.id);
  const keys = useMemo(() => variantKeys(variants.data ?? []), [variants.data]);
  const info = publishStatusInfo(provider, saved.publish_status);
  const name = providerLabels[provider];
  const article = provider === 'mercadolivre' ? 'o' : 'a';
  const where = inMarketplace(provider);
  const published = Boolean(saved.external_id);
  const busy = publish.isPending || saved.publish_status === 'publishing';
  const error = publish.error instanceof PublishRequestError ? publish.error : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-semibold">Publicar {where}</h3>
        <span className="flex items-center gap-2 text-sm">
          <StatusDot tone={info.tone} />
          {info.label}
        </span>
        {saved.external_url && (
          <a
            href={saved.external_url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-brand text-sm underline"
          >
            Ver anúncio {saved.external_id}
          </a>
        )}
        {!saved.external_url && saved.external_id && (
          <span className="text-muted text-sm">Anúncio {saved.external_id}</span>
        )}
      </div>

      {saved.last_error && !publish.isPending && (
        <Alert tone="error">Última tentativa: {saved.last_error}</Alert>
      )}

      {!saved.marketplace_category ? (
        <Alert tone="info">
          Informe o código da categoria {provider === 'mercadolivre' ? 'do' : 'da'} {name} acima
          (use "Sugerir categoria") e salve para ver os atributos que ela pede.
        </Alert>
      ) : category.isPending || variants.isPending ? (
        <PageLoader />
      ) : category.isError ? (
        <Alert tone="error">
          {category.error instanceof PublishRequestError
            ? category.error.message
            : 'Não foi possível carregar a categoria.'}{' '}
          Confira o código {saved.marketplace_category}.
        </Alert>
      ) : (
        <>
          <p className="text-muted text-sm">
            Categoria: <span className="text-fg">{category.data.path || category.data.name}</span>
          </p>
          <AttributesForm
            key={`${saved.updated_at}:${category.data.category_id}`}
            provider={provider}
            product={product}
            saved={saved}
            category={category.data}
            keys={keys}
            canEdit={canEdit}
          />
        </>
      )}

      {publish.isSuccess && (
        <Alert tone="success">
          {publish.variables === 'pause'
            ? 'Anúncio pausado.'
            : publish.variables === 'activate'
              ? 'Anúncio reativado.'
              : `Anúncio enviado ${article === 'o' ? 'ao' : 'à'} ${name}. Pedidos e estoque deste produto passam a sincronizar.`}
          {publish.data.skipped && publish.data.skipped.length > 0 && (
            <>
              {' '}
              {provider === 'mercadolivre'
                ? `Variações sem estoque ficaram de fora: ${publish.data.skipped.join(', ')}. Publique de novo quando tiverem estoque.`
                : `Variações que ainda não existem no anúncio ficaram de fora: ${publish.data.skipped.join(', ')}. Crie-as ${where}.`}
            </>
          )}
        </Alert>
      )}
      {publish.isError && (
        <Alert tone="error">
          {error?.message ?? `Não foi possível falar com ${article} ${name}.`}
          {error && error.messages.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {error.messages.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
          {error?.message.includes('Integrações') && (
            <>
              {' '}
              <Link to="/integracoes" className="underline">
                Ir para Integrações
              </Link>
            </>
          )}
        </Alert>
      )}

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button
            loading={publish.isPending && publish.variables === 'publish'}
            disabled={busy || !saved.enabled}
            onClick={() => publish.mutate('publish')}
          >
            {published ? 'Atualizar anúncio' : `Publicar ${where}`}
          </Button>
          {published && saved.publish_status === 'active' && (
            <Button
              variant="secondary"
              loading={publish.isPending && publish.variables === 'pause'}
              disabled={busy}
              onClick={() => publish.mutate('pause')}
            >
              Pausar
            </Button>
          )}
          {published && saved.publish_status === 'paused' && (
            <Button
              variant="secondary"
              loading={publish.isPending && publish.variables === 'activate'}
              disabled={busy}
              onClick={() => publish.mutate('activate')}
            >
              Reativar
            </Button>
          )}
        </div>
      )}
      <p className="text-muted text-xs">
        Publicar usa o título, preço, tipo de anúncio e frete salvos acima, as fotos e a descrição
        do produto. {variationNote[provider]} Mudou algo? Salve e clique em "Atualizar anúncio".
      </p>
    </div>
  );
}
