-- =====================================================================
-- Fase 14 · Credenciais de API criptografadas e envio de estoque
--
-- Para enviar estoque, o sistema precisa chamar a API do marketplace com as
-- credenciais do vendedor. Elas NUNCA ficam em texto no banco:
--
--  * A Edge Function `credentials` (JWT do usuário) criptografa com
--    AES-256-GCM usando CREDENTIALS_ENCRYPTION_KEY (segredo da função, que
--    o banco nunca vê) e grava só o texto cifrado por `store_connection_credentials`.
--  * O worker `stock-sync` (service role) lê o texto cifrado, decifra e chama
--    a API. Nenhuma RPC devolve credencial, cifrada ou não.
--  * `config` guarda só dados NÃO secretos (ex.: id do local de estoque).
--  * Desconectar apaga as credenciais.
-- =====================================================================

create table public.integration_credentials (
  connection_id uuid primary key references public.integration_connections (id) on delete cascade,
  ciphertext text not null check (char_length(ciphertext) between 20 and 8000),
  key_version smallint not null default 1,
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  updated_at timestamptz not null default now()
);

alter table public.integration_credentials enable row level security;
revoke all on table public.integration_credentials from anon, authenticated;
grant select on table public.integration_credentials to service_role;

/** Guarda o texto cifrado (a criptografia acontece na Edge Function). */
create function public.store_connection_credentials(
  p_connection uuid,
  p_ciphertext text,
  p_key_version smallint,
  p_config jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.integration_connections%rowtype;
begin
  select * into v_conn from public.integration_connections c where c.id = p_connection;
  if v_conn.id is null or not private.has_org_role(v_conn.organization_id, '{owner,admin}') then
    raise exception 'integrations.not_found';
  end if;
  if v_conn.status = 'disconnected' then
    raise exception 'integrations.disconnected';
  end if;

  insert into public.integration_credentials (connection_id, ciphertext, key_version, config)
  values (p_connection, p_ciphertext, coalesce(p_key_version, 1), coalesce(p_config, '{}'::jsonb))
  on conflict (connection_id) do update
    set ciphertext = excluded.ciphertext, key_version = excluded.key_version,
        config = excluded.config, updated_at = now();
end;
$$;

/** Só informa SE há credenciais (e quando foram trocadas); nunca o conteúdo. */
create function public.connection_credentials_status(p_connection uuid)
returns table (configured boolean, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select c.organization_id into v_org from public.integration_connections c where c.id = p_connection;
  if v_org is null or not private.has_org_role(v_org, '{owner,admin}') then
    raise exception 'integrations.not_found';
  end if;
  return query
  select (k.connection_id is not null), k.updated_at
  from (select 1) x
  left join public.integration_credentials k on k.connection_id = p_connection;
end;
$$;

-- Desconectar também apaga as credenciais (create or replace mantém os grants).
create or replace function public.set_connection_status(p_connection uuid, p_status public.connection_status)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.integration_connections%rowtype;
begin
  select * into v_conn from public.integration_connections c where c.id = p_connection for update;
  if v_conn.id is null or not private.has_org_role(v_conn.organization_id, '{owner,admin}') then
    raise exception 'integrations.not_found';
  end if;
  if v_conn.status = 'disconnected' then
    raise exception 'integrations.disconnected';
  end if;

  if p_status = 'disconnected' then
    delete from public.integration_secrets where connection_id = p_connection;
    delete from public.integration_credentials where connection_id = p_connection;
    -- Nada de estoque pendente para uma conexão encerrada.
    delete from public.stock_sync_outbox o using public.listing_links l
    where o.link_id = l.id and l.connection_id = p_connection and o.done_at is null;
  end if;
  update public.integration_connections set status = p_status where id = p_connection;
end;
$$;

grant execute on function public.store_connection_credentials(uuid, text, smallint, jsonb) to authenticated;
grant execute on function public.connection_credentials_status(uuid) to authenticated;
