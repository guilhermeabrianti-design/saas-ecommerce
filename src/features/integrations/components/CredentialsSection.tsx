import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import {
  credentialsErrorMessage,
  useCredentialsStatus,
  useSaveCredentials,
  type Connection,
} from '../api';
import {
  shopifyCredentialsSchema,
  wooCredentialsSchema,
  type ShopifyCredentialsValues,
  type WooCredentialsValues,
} from '../schemas';

function ShopifyForm({ connection }: { connection: Connection }) {
  const save = useSaveCredentials(connection.id);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ShopifyCredentialsValues>({
    resolver: zodResolver(shopifyCredentialsSchema),
    defaultValues: { accessToken: '', locationId: '' },
  });
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={handleSubmit((v) =>
        save.mutate(
          { access_token: v.accessToken, location_id: v.locationId },
          { onSuccess: () => reset() },
        ),
      )}
    >
      <TextField
        label="Token de acesso da Admin API"
        type="password"
        autoComplete="off"
        className="font-mono"
        hint="App personalizado na Shopify com permissão de leitura de produtos e escrita de estoque (read_products, write_inventory)."
        error={errors.accessToken?.message}
        {...register('accessToken')}
      />
      <TextField
        label="ID do local de estoque"
        inputMode="numeric"
        autoComplete="off"
        hint="Número do local (Configurações → Locais). Aceita também gid://shopify/Location/…"
        error={errors.locationId?.message}
        {...register('locationId')}
      />
      <SubmitRow save={save} />
    </form>
  );
}

function WooForm({ connection }: { connection: Connection }) {
  const save = useSaveCredentials(connection.id);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<WooCredentialsValues>({
    resolver: zodResolver(wooCredentialsSchema),
    defaultValues: { consumerKey: '', consumerSecret: '' },
  });
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={handleSubmit((v) =>
        save.mutate(
          { consumer_key: v.consumerKey, consumer_secret: v.consumerSecret },
          { onSuccess: () => reset() },
        ),
      )}
    >
      <TextField
        label="Consumer key"
        autoComplete="off"
        className="font-mono"
        hint="WooCommerce → Configurações → Avançado → API REST, com permissão de leitura/escrita."
        error={errors.consumerKey?.message}
        {...register('consumerKey')}
      />
      <TextField
        label="Consumer secret"
        type="password"
        autoComplete="off"
        className="font-mono"
        error={errors.consumerSecret?.message}
        {...register('consumerSecret')}
      />
      <SubmitRow save={save} />
    </form>
  );
}

function SubmitRow({ save }: { save: ReturnType<typeof useSaveCredentials> }) {
  return (
    <div className="space-y-3">
      {save.isError && <Alert tone="error">{credentialsErrorMessage(save.error)}</Alert>}
      {save.isSuccess && (
        <Alert tone="success">Credenciais guardadas com criptografia. O valor não é exibido.</Alert>
      )}
      <Button type="submit" loading={save.isPending}>
        Guardar credenciais
      </Button>
    </div>
  );
}

/** Credenciais de API para enviar estoque. São gravadas cifradas e nunca exibidas. */
export function CredentialsSection({ connection }: { connection: Connection }) {
  const status = useCredentialsStatus(connection.id);
  const updated = status.data?.updated_at
    ? new Date(status.data.updated_at).toLocaleString('pt-BR')
    : null;

  return (
    <div className="space-y-5">
      <p className="text-sm">
        {status.isPending ? (
          <span className="text-muted">Verificando…</span>
        ) : status.data?.configured ? (
          <span className="text-success">
            Configuradas{updated ? ` (atualizadas em ${updated})` : ''}. Preencha de novo para
            substituir.
          </span>
        ) : (
          <span className="text-muted">
            Não configuradas: o estoque só é enviado ao marketplace depois de guardar as
            credenciais.
          </span>
        )}
      </p>
      {connection.provider === 'shopify' ? (
        <ShopifyForm connection={connection} />
      ) : (
        <WooForm connection={connection} />
      )}
    </div>
  );
}
