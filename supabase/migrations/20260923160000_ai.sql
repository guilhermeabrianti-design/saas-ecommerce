-- =====================================================================
-- Fase 13 · IA: descrição de produto assistida
--
-- A Edge Function `ai` chama o modelo; o banco decide QUEM pode, aplica a
-- COTA e entrega só os dados do produto necessários ao prompt. Tudo roda
-- com o JWT do usuário (nenhum service role): a autorização é a mesma das
-- demais RPCs.
--
--  * Só owner/admin da organização, só produto da própria organização.
--  * Cota diária por organização (fuso de São Paulo). Tentativa que falha
--    não consome cota; reserva presa (função caiu) expira em 5 minutos.
--  * `ai_usage`: log de uso (tokens) sem nenhum acesso pela API.
--  * O texto gerado NÃO é salvo: volta ao navegador como sugestão e só
--    entra no produto se a pessoa revisar e salvar.
-- =====================================================================

create type public.ai_usage_status as enum ('started', 'done', 'failed');

create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid,
  feature text not null check (char_length(feature) between 1 and 40),
  product_id uuid,
  status public.ai_usage_status not null default 'started',
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index ai_usage_org_created_idx on public.ai_usage (organization_id, created_at desc);

alter table public.ai_usage enable row level security;
revoke all on table public.ai_usage from anon, authenticated;

/** Limite diário de gerações por organização. */
create function private.ai_daily_limit()
returns integer
language sql
immutable
set search_path = ''
as $$ select 50 $$;

/** Gerações que contam hoje: concluídas + em andamento recentes. */
create function private.ai_used_today(p_org uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.ai_usage u
  where u.organization_id = p_org
    and u.created_at >= private.analytics_start(1)
    and (u.status = 'done'
         or (u.status = 'started' and u.created_at > now() - interval '5 minutes'))
$$;

/** Uso do dia (owner/admin) para mostrar a cota restante. */
create function public.ai_usage_today(p_org uuid)
returns table (used integer, daily_limit integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_org_role(p_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  return query select private.ai_used_today(p_org), private.ai_daily_limit();
end;
$$;

/**
 * Autoriza e reserva uma geração de descrição. Devolve o id do uso e os
 * dados do produto (do banco, nunca do cliente) para montar o prompt.
 */
create function public.ai_begin_description(p_org uuid, p_product uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products%rowtype;
  v_usage uuid;
  v_used integer;
begin
  if not private.has_org_role(p_org, '{owner,admin}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;

  select * into v_product from public.products p
  where p.id = p_product and p.organization_id = p_org;
  if v_product.id is null then
    raise exception 'ai.product_not_found';
  end if;

  -- Serializa por organização para a cota não estourar com chamadas paralelas.
  perform pg_advisory_xact_lock(hashtextextended('ai:' || p_org::text, 0));
  v_used := private.ai_used_today(p_org);
  if v_used >= private.ai_daily_limit() then
    raise exception 'ai.quota_exceeded';
  end if;

  insert into public.ai_usage (organization_id, user_id, feature, product_id)
  values (p_org, auth.uid(), 'product_description', p_product)
  returning id into v_usage;

  return jsonb_build_object(
    'usage_id', v_usage,
    'remaining', private.ai_daily_limit() - v_used - 1,
    'product', jsonb_build_object(
      'name', v_product.name,
      'brand', v_product.brand,
      'sku', v_product.sku,
      'description', v_product.description,
      'weight_grams', v_product.weight_grams,
      'variants', coalesce((
        select jsonb_agg(v.attributes order by v.created_at)
        from (select pv.attributes, pv.created_at from public.product_variants pv
              where pv.product_id = p_product and pv.is_active
              order by pv.created_at limit 20) v
      ), '[]'::jsonb)
    )
  );
end;
$$;

/** Fecha a reserva: sucesso (com tokens) ou falha (devolve a cota). Só quem abriu. */
create function public.ai_finish(p_usage uuid, p_ok boolean, p_input_tokens integer, p_output_tokens integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.ai_usage%rowtype;
begin
  select * into v_row from public.ai_usage u
  where u.id = p_usage and u.user_id = auth.uid() for update;
  if v_row.id is null or v_row.status <> 'started' then
    raise exception 'ai.usage_not_found';
  end if;
  update public.ai_usage
  set status = case when p_ok then 'done' else 'failed' end::public.ai_usage_status,
      input_tokens = case when p_ok then greatest(p_input_tokens, 0) end,
      output_tokens = case when p_ok then greatest(p_output_tokens, 0) end,
      finished_at = now()
  where id = p_usage;
end;
$$;

grant execute on function public.ai_usage_today(uuid) to authenticated;
grant execute on function public.ai_begin_description(uuid, uuid) to authenticated;
grant execute on function public.ai_finish(uuid, boolean, integer, integer) to authenticated;
