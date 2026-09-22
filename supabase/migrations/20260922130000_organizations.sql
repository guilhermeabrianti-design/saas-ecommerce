-- =====================================================================
-- Fase 3 · Organizações (tenants) e RLS deny-by-default
--
-- Todo dado de negócio pertence a uma organização (`organization_id`).
-- Um usuário acessa apenas as organizações das quais é membro; isso é
-- garantido aqui, no PostgreSQL, e nunca no frontend.
--
-- Papéis dentro da organização (independentes de profiles.role):
--   owner  · tudo, inclusive gerenciar papéis. Sempre há ao menos um.
--   admin  · renomeia a organização, convida/remove membros comuns.
--   member · leitura.
--
-- Escritas em membros e convites passam por funções RPC com as regras
-- explícitas; as tabelas só são legíveis diretamente.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Deny-by-default
-- O Supabase concede ALL em objetos novos do schema public para
-- anon/authenticated. A partir daqui, nada novo nasce acessível: cada
-- migração concede explicitamente o que precisa.
-- ---------------------------------------------------------------------
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges revoke execute on functions from public;

-- Função de trigger da Fase 2 criada antes do deny-by-default.
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- Helpers usados pelas policies. Fora do schema public, portanto não
-- expostos pela API (PostgREST).
create schema private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------
-- 2. Tipos e tabelas
-- ---------------------------------------------------------------------
create type public.org_role as enum ('owner', 'admin', 'member');
create type public.org_kind as enum ('seller', 'supplier');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (name = btrim(name) and char_length(name) between 2 and 80),
  kind public.org_kind not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.organizations is
  'Tenant. kind acompanha o tipo de conta de quem criou (seller|supplier) e é imutável.';

create table public.organization_members (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.org_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create index organization_members_user_id_idx on public.organization_members (user_id);

create table public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email text not null check (
    email = lower(btrim(email)) and char_length(email) between 3 and 254 and email like '%_@_%'
  ),
  role public.org_role not null check (role <> 'owner'),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  unique (organization_id, email)
);

create index organization_invitations_email_idx on public.organization_invitations (email);

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 3. Helpers de autorização
-- security definer: leem organization_members sem passar pela RLS dela
-- (evita recursão nas policies).
-- ---------------------------------------------------------------------
create function private.org_role_of(p_org uuid)
returns public.org_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.organization_members m
  where m.organization_id = p_org and m.user_id = (select auth.uid())
$$;

create function private.is_org_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.org_role_of(p_org) is not null
$$;

create function private.has_org_role(p_org uuid, p_roles public.org_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.org_role_of(p_org) = any (p_roles), false)
$$;

/**
 * E-mail (minúsculo) do usuário da requisição, só se confirmado. Convites
 * são entregues por e-mail: sem confirmação, qualquer um poderia se
 * cadastrar com o e-mail de outra pessoa e aceitar o convite dela.
 */
create function private.current_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(u.email)
  from auth.users u
  where u.id = (select auth.uid()) and u.email_confirmed_at is not null
$$;

grant execute on function private.org_role_of(uuid) to authenticated;
grant execute on function private.is_org_member(uuid) to authenticated;
grant execute on function private.has_org_role(uuid, public.org_role[]) to authenticated;
grant execute on function private.current_email() to authenticated;

-- ---------------------------------------------------------------------
-- 4. Privilégios e RLS
-- ---------------------------------------------------------------------
revoke all on table public.organizations from anon, authenticated;
revoke all on table public.organization_members from anon, authenticated;
revoke all on table public.organization_invitations from anon, authenticated;

grant select on table public.organizations to authenticated;
grant update (name) on table public.organizations to authenticated;
grant select on table public.organization_members to authenticated;
grant select on table public.organization_invitations to authenticated;

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.organization_invitations enable row level security;

create policy "organizations: membros leem"
  on public.organizations for select
  to authenticated
  using (private.is_org_member(id));

create policy "organizations: owner/admin renomeiam"
  on public.organizations for update
  to authenticated
  using (private.has_org_role(id, '{owner,admin}'))
  with check (private.has_org_role(id, '{owner,admin}'));

create policy "organization_members: membros leem os membros da organização"
  on public.organization_members for select
  to authenticated
  using (private.is_org_member(organization_id));

create policy "organization_invitations: owner/admin leem os convites"
  on public.organization_invitations for select
  to authenticated
  using (private.has_org_role(organization_id, '{owner,admin}'));

-- ---------------------------------------------------------------------
-- 5. RPCs
-- Erros de regra de negócio usam mensagens estáveis (`org.*`) que o
-- frontend traduz. Toda operação que altera membros trava a linha da
-- organização para serializar a regra "ao menos um owner".
-- ---------------------------------------------------------------------

/** Cria uma organização e torna quem chamou seu owner. */
create function public.create_organization(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_account public.app_role;
  v_org uuid;
begin
  if v_uid is null then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;

  select p.role into v_account from public.profiles p where p.id = v_uid;
  if v_account is null or v_account = 'admin' then
    raise exception 'org.account_type_not_allowed' using errcode = '42501';
  end if;

  if (select count(*) from public.organizations o where o.created_by = v_uid) >= 10 then
    raise exception 'org.limit_reached';
  end if;

  insert into public.organizations (name, kind, created_by)
  values (btrim(p_name), v_account::text::public.org_kind, v_uid)
  returning id into v_org;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_org, v_uid, 'owner');

  return v_org;
end;
$$;

/** Membros com nome e e-mail. Visível a qualquer membro da organização. */
create function public.list_organization_members(p_org uuid)
returns table (
  user_id uuid,
  full_name text,
  email text,
  role public.org_role,
  joined_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_org_member(p_org) then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;

  return query
    select m.user_id, p.full_name, u.email::text, m.role, m.created_at
    from public.organization_members m
    join public.profiles p on p.id = m.user_id
    join auth.users u on u.id = m.user_id
    where m.organization_id = p_org
    order by m.created_at;
end;
$$;

/**
 * Convida um e-mail. Owner convida admin/member; admin só convida member.
 * Reenviar para o mesmo e-mail renova o convite.
 */
create function public.invite_member(p_org uuid, p_email text, p_role public.org_role)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller public.org_role := private.org_role_of(p_org);
  v_email text := lower(btrim(p_email));
  v_id uuid;
begin
  if v_caller is null or v_caller = 'member' then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  if p_role = 'owner' or (p_role = 'admin' and v_caller <> 'owner') then
    raise exception 'org.invalid_role' using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.organization_members m
    join auth.users u on u.id = m.user_id
    where m.organization_id = p_org and lower(u.email) = v_email
  ) then
    raise exception 'org.already_member';
  end if;

  if (
    select count(*) from public.organization_invitations i
    where i.organization_id = p_org and i.expires_at > now()
  ) >= 100 then
    raise exception 'org.limit_reached';
  end if;

  insert into public.organization_invitations (organization_id, email, role, invited_by)
  values (p_org, v_email, p_role, auth.uid())
  on conflict (organization_id, email) do update
    set role = excluded.role,
        invited_by = excluded.invited_by,
        created_at = now(),
        expires_at = now() + interval '7 days'
  returning id into v_id;

  return v_id;
end;
$$;

create function public.revoke_invitation(p_invitation uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select i.organization_id into v_org
  from public.organization_invitations i
  where i.id = p_invitation;

  if v_org is null or not private.has_org_role(v_org, '{owner,admin}') then
    raise exception 'org.invitation_not_found';
  end if;

  delete from public.organization_invitations where id = p_invitation;
end;
$$;

/** Convites válidos endereçados ao e-mail de quem chama. */
create function public.my_pending_invitations()
returns table (
  id uuid,
  organization_id uuid,
  organization_name text,
  organization_kind public.org_kind,
  role public.org_role,
  invited_by_name text,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, o.id, o.name, o.kind, i.role, p.full_name, i.expires_at
  from public.organization_invitations i
  join public.organizations o on o.id = i.organization_id
  left join public.profiles p on p.id = i.invited_by
  where i.email = private.current_email()
    and i.expires_at > now()
  order by i.created_at desc
$$;

/**
 * Aceita um convite endereçado ao e-mail (confirmado) de quem chama.
 * O tipo de conta precisa bater com o tipo da organização.
 */
create function public.accept_invitation(p_invitation uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_inv public.organization_invitations%rowtype;
  v_kind public.org_kind;
  v_account public.app_role;
begin
  select * into v_inv
  from public.organization_invitations i
  where i.id = p_invitation
    and i.email = private.current_email()
    and i.expires_at > now()
  for update;

  -- Mesmo erro para inexistente, expirado ou de outra pessoa.
  if v_inv.id is null or v_uid is null then
    raise exception 'org.invitation_not_found';
  end if;

  select o.kind into v_kind from public.organizations o where o.id = v_inv.organization_id for update;
  select p.role into v_account from public.profiles p where p.id = v_uid;
  if v_account is null or v_account::text <> v_kind::text then
    raise exception 'org.account_type_mismatch';
  end if;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_inv.organization_id, v_uid, v_inv.role)
  on conflict (organization_id, user_id) do nothing;

  delete from public.organization_invitations where id = v_inv.id;
  return v_inv.organization_id;
end;
$$;

create function public.decline_invitation(p_invitation uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.organization_invitations i
  where i.id = p_invitation and i.email = private.current_email();

  if not found then
    raise exception 'org.invitation_not_found';
  end if;
end;
$$;

/** Só owners alteram papéis. O último owner não pode ser rebaixado. */
create function public.update_member_role(p_org uuid, p_user uuid, p_role public.org_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current public.org_role;
begin
  perform 1 from public.organizations o where o.id = p_org for update;

  if not private.has_org_role(p_org, '{owner}') then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;

  select m.role into v_current
  from public.organization_members m
  where m.organization_id = p_org and m.user_id = p_user;

  if v_current is null then
    raise exception 'org.member_not_found';
  end if;

  if v_current = 'owner' and p_role <> 'owner' and (
    select count(*) from public.organization_members m
    where m.organization_id = p_org and m.role = 'owner'
  ) = 1 then
    raise exception 'org.last_owner';
  end if;

  update public.organization_members
  set role = p_role
  where organization_id = p_org and user_id = p_user;
end;
$$;

/**
 * Remove um membro. Qualquer membro pode sair (p_user = si mesmo);
 * owner remove qualquer um; admin remove apenas membros comuns.
 * O último owner não pode sair nem ser removido.
 */
create function public.remove_member(p_org uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller public.org_role;
  v_target public.org_role;
begin
  perform 1 from public.organizations o where o.id = p_org for update;

  v_caller := private.org_role_of(p_org);
  if v_caller is null then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;

  select m.role into v_target
  from public.organization_members m
  where m.organization_id = p_org and m.user_id = p_user;

  if v_target is null then
    raise exception 'org.member_not_found';
  end if;

  if p_user <> auth.uid() and not (
    v_caller = 'owner' or (v_caller = 'admin' and v_target = 'member')
  ) then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;

  if v_target = 'owner' and (
    select count(*) from public.organization_members m
    where m.organization_id = p_org and m.role = 'owner'
  ) = 1 then
    raise exception 'org.last_owner';
  end if;

  delete from public.organization_members
  where organization_id = p_org and user_id = p_user;
end;
$$;

grant execute on function public.create_organization(text) to authenticated;
grant execute on function public.list_organization_members(uuid) to authenticated;
grant execute on function public.invite_member(uuid, text, public.org_role) to authenticated;
grant execute on function public.revoke_invitation(uuid) to authenticated;
grant execute on function public.my_pending_invitations() to authenticated;
grant execute on function public.accept_invitation(uuid) to authenticated;
grant execute on function public.decline_invitation(uuid) to authenticated;
grant execute on function public.update_member_role(uuid, uuid, public.org_role) to authenticated;
grant execute on function public.remove_member(uuid, uuid) to authenticated;
