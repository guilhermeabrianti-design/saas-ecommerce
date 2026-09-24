import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { TextField } from '@/components/ui/TextField';
import { providerLabels, providers } from '@/features/integrations/schemas';
import { useSaveFeeRule } from '../api';
import {
  categoryPath,
  feeRuleFormSchema,
  feesErrorMessage,
  sortCategories,
  toFeeRuleFormValues,
  type Category,
  type FeeRule,
  type FeeRuleFormValues,
} from '../fees';

/** Cria ou edita uma regra de taxa de marketplace (equipe). */
export function FeeRuleForm({
  rule,
  categories,
  onDone,
}: {
  rule: FeeRule | null;
  categories: Category[];
  onDone: () => void;
}) {
  const save = useSaveFeeRule();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FeeRuleFormValues>({
    resolver: zodResolver(feeRuleFormSchema),
    defaultValues: toFeeRuleFormValues(rule),
  });

  const onSubmit = handleSubmit((values) =>
    save.mutate({ id: rule?.id ?? null, values }, { onSuccess: onDone }),
  );

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="border-border bg-surface-2/40 space-y-4 rounded-lg border p-4"
    >
      <p className="text-sm font-medium">{rule ? 'Editar regra' : 'Nova regra de taxa'}</p>
      {save.isError && <Alert tone="error">{feesErrorMessage(save.error)}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Select label="Marketplace" {...register('provider')}>
          {providers.map((p) => (
            <option key={p} value={p}>
              {providerLabels[p]}
            </option>
          ))}
        </Select>
        <TextField
          label="Tipo de anúncio (código)"
          placeholder="classico, premium, padrao, live"
          error={errors.listingType?.message}
          {...register('listingType')}
        />
        <TextField
          label="Nome exibido"
          placeholder="Clássico"
          error={errors.label?.message}
          {...register('label')}
        />
        <Select label="Categoria" {...register('categoryId')}>
          <option value="">Todas as categorias</option>
          {sortCategories(categories).map((c) => (
            <option key={c.id} value={c.id}>
              {categoryPath(c, categories)}
              {c.is_active ? '' : ' (desativada)'}
            </option>
          ))}
        </Select>
        <TextField
          label="Campanha (opcional)"
          placeholder="Vazio = regra base"
          hint="Regra de campanha soma à regra base."
          error={errors.campaign?.message}
          {...register('campaign')}
        />
        <TextField
          label="Comissão (%)"
          inputMode="decimal"
          placeholder="14"
          error={errors.percent?.message}
          {...register('percent')}
        />
        <TextField
          label="Custo fixo por item (R$)"
          inputMode="decimal"
          placeholder="0,00"
          error={errors.fixed?.message}
          {...register('fixed')}
        />
        <TextField
          label="Preço unitário a partir de (R$)"
          inputMode="decimal"
          placeholder="0,00"
          error={errors.minPrice?.message}
          {...register('minPrice')}
        />
        <TextField
          label="Preço unitário abaixo de (R$)"
          inputMode="decimal"
          placeholder="Sem limite"
          error={errors.maxPrice?.message}
          {...register('maxPrice')}
        />
      </div>
      <TextField
        label="Observações (fonte, data da tabela oficial)"
        error={errors.notes?.message}
        {...register('notes')}
      />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="accent-brand size-4" {...register('isActive')} />
        Ativa (usada nos cálculos)
      </label>
      <div className="flex gap-2">
        <Button type="submit" loading={save.isPending}>
          Salvar regra
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
