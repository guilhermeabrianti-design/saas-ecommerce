import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { getSupabase } from '@/lib/supabase';
import { connectErrorMessage } from '../mercadolivre';

/** Começa o OAuth e leva a pessoa para autorizar no Mercado Livre. */
export function MercadoLivreConnect({
  orgId,
  defaultName = 'Mercado Livre',
  label = 'Conectar Mercado Livre',
}: {
  orgId: string;
  defaultName?: string;
  label?: string;
}) {
  const [name, setName] = useState(defaultName);
  const connect = useMutation({
    mutationFn: async () => {
      const { data, error } = await getSupabase().functions.invoke('mercadolivre/connect', {
        body: { organization_id: orgId, name: name.trim() },
      });
      if (error) {
        let code: string | null = null;
        if (error instanceof FunctionsHttpError) {
          code =
            ((await error.context.json().catch(() => null)) as { error?: string } | null)?.error ??
            null;
        }
        throw { message: connectErrorMessage(code) };
      }
      const url = (data as { url?: string }).url;
      if (!url?.startsWith('https://auth.mercadolivre.com.br/'))
        throw { message: connectErrorMessage(null) };
      window.location.assign(url);
    },
  });
  const valid = name.trim().length >= 2 && name.trim().length <= 80;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) connect.mutate();
      }}
    >
      {connect.isError && (
        <Alert tone="error">{(connect.error as { message?: string }).message}</Alert>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <TextField
            label="Nome da conexão"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={!valid} loading={connect.isPending}>
          {label}
        </Button>
      </div>
      <p className="text-muted text-xs">
        Você autoriza no próprio Mercado Livre; a TheSigns recebe um acesso que pode ser revogado lá
        a qualquer momento.
      </p>
    </form>
  );
}
