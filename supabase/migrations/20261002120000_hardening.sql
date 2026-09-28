-- =====================================================================
-- Fase 26 · Rate limiting e endurecimento, MFA para a equipe
--
--  * Limites de uso em janela fixa, guardados no schema `private` (fora
--    da API). Usados por gatilhos nas escritas que um usuário pode repetir
--    em massa e, pela Edge Function `checkout`, por IP (só o hash) nas
--    rotas públicas.
--  * Equipe da plataforma só age com sessão verificada em duas etapas
--    (aal2, TOTP do Supabase Auth): `private.is_platform_admin()` — usada
--    por todas as RPCs e policies da equipe — passa a exigir aal2.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Rate limiting
-- ---------------------------------------------------------------------
create table private.rate_limits (
  bucket text not null,
  subject text not null,
  window_start timestamptz not null,
  hits integer not null default 1,
  primary key (bucket, subject, window_start)
);

create index rate_limits_window_idx on private.rate_limits (window_start);

revoke all on table private.rate_limits from public, anon, authenticated;

/**
 * Conta um uso de `subject` no `bucket` e diz se ainda está dentro do
 * limite (janela fixa de p_window_seconds).
 */
create function private.rate_limit(p_bucket text, p_subject text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );
  v_hits integer;
begin
  insert into private.rate_limits (bucket, subject, window_start)
  values (p_bucket, p_subject, v_window)
  on conflict (bucket, subject, window_start)
  do update set hits = private.rate_limits.hits + 1
  returning hits into v_hits;

  -- Limpeza ocasional de janelas antigas.
  if random() < 0.01 then
    delete from private.rate_limits where window_start < now() - interval '2 days';
  end if;

  return v_hits <= p_limit;
end;
$$;

/** Levanta `rate_limited` quando o limite estoura. */
create function private.enforce_rate_limit(p_bucket text, p_subject text, p_limit integer, p_window_seconds integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_subject is not null and not private.rate_limit(p_bucket, p_subject, p_limit, p_window_seconds) then
    raise exception 'rate_limited' using errcode = 'P0001', hint = p_bucket;
  end if;
end;
$$;

/** Para a Edge Function (service role): true = pode seguir. */
create function public.rate_limit_hit(p_bucket text, p_subject text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_bucket !~ '^[a-z_.]{3,40}$' or p_subject is null or char_length(p_subject) not between 1 and 128
     or p_limit not between 1 and 100000 or p_window_seconds not between 1 and 86400 then
    raise exception 'rate_limit.invalid';
  end if;
  return private.rate_limit(p_bucket, p_subject, p_limit, p_window_seconds);
end;
$$;

-- Escritas repetíveis por usuários: um gatilho por tabela, com o limite ao lado.
create function private.limit_inserts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Argumentos do gatilho: bucket, coluna do "dono", limite, janela (s).
  v_subject text := to_jsonb(new) ->> tg_argv[1];
begin
  perform private.enforce_rate_limit(tg_argv[0], v_subject, tg_argv[2]::integer, tg_argv[3]::integer);
  return new;
end;
$$;

create trigger organization_invitations_rate_limit
  before insert on public.organization_invitations
  for each row execute function private.limit_inserts('invitations', 'organization_id', '50', '3600');

create trigger withdrawal_requests_rate_limit
  before insert on public.withdrawal_requests
  for each row execute function private.limit_inserts('withdrawals', 'organization_id', '10', '86400');

create trigger affiliate_links_rate_limit
  before insert on public.affiliate_links
  for each row execute function private.limit_inserts('affiliate_links', 'organization_id', '50', '3600');

create trigger academy_questions_rate_limit
  before insert on public.academy_questions
  for each row execute function private.limit_inserts('academy_questions', 'user_id', '20', '3600');

create trigger products_rate_limit
  before insert on public.products
  for each row execute function private.limit_inserts('products', 'organization_id', '1000', '3600');

-- ---------------------------------------------------------------------
-- MFA da equipe
-- ---------------------------------------------------------------------

/** Nível de autenticação da sessão atual (aal1 = senha, aal2 = segundo fator). */
create function private.current_aal()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1')
$$;

create or replace function private.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_aal() = 'aal2' and exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin'
  )
$$;

-- Helper de policy (roda com o papel de quem consulta).
grant execute on function private.current_aal() to authenticated;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function private.rate_limit(text, text, integer, integer) from public, anon, authenticated;
revoke execute on function private.enforce_rate_limit(text, text, integer, integer) from public, anon, authenticated;
revoke execute on function private.limit_inserts() from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, text, integer, integer) to service_role;
