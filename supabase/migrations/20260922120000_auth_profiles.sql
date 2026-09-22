-- =====================================================================
-- Fase 2 · Auth: perfis de usuário e papéis (RBAC)
--
-- Cada usuário do Supabase Auth recebe exatamente um perfil, criado por
-- trigger no cadastro. O papel (`role`) é escolhido no cadastro apenas
-- entre `seller` e `supplier`; `admin` (equipe TheSigns) só pode ser
-- atribuído via service role / SQL — nunca pelo próprio usuário.
--
-- Isolamento por organização (tenant) é tratado na Fase 3.
-- =====================================================================

create type public.app_role as enum ('seller', 'supplier', 'admin');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null check (char_length(btrim(full_name)) between 2 and 120),
  role public.app_role not null default 'seller',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'Perfil 1:1 com auth.users. Criado pelo trigger on_auth_user_created.';
comment on column public.profiles.role is
  'seller|supplier escolhido no cadastro; admin somente via service role. Imutável pelo usuário.';

-- ---------------------------------------------------------------------
-- Privilégios: o Supabase concede ALL em tabelas novas do schema public
-- para anon/authenticated por padrão. Revogamos tudo e concedemos apenas
-- o necessário. Usuários só podem alterar o próprio nome.
-- ---------------------------------------------------------------------
revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;
grant update (full_name) on table public.profiles to authenticated;

alter table public.profiles enable row level security;

create policy "profiles: usuário lê o próprio perfil"
  on public.profiles for select
  to authenticated
  using (id = (select auth.uid()));

create policy "profiles: usuário atualiza o próprio perfil"
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- updated_at automático
-- ---------------------------------------------------------------------
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Criação do perfil no cadastro.
-- `raw_user_meta_data` é controlado pelo cliente: o papel pedido é
-- restrito a seller|supplier e o nome é saneado; nunca confiamos nele
-- para conceder `admin`.
-- ---------------------------------------------------------------------
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requested_role text := new.raw_user_meta_data ->> 'account_type';
  v_full_name text := btrim(coalesce(new.raw_user_meta_data ->> 'full_name', ''));
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    case
      when char_length(v_full_name) between 2 and 120 then v_full_name
      else 'Usuário'
    end,
    case
      when v_requested_role = 'supplier' then 'supplier'::public.app_role
      else 'seller'::public.app_role
    end
  );
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
