-- =====================================================================
-- Convite por link: quem recebe já entra na empresa certa
--
--  * Cada conta é a sua empresa (criada no primeiro acesso) e ninguém
--    procura nem escolhe empresa. Para pôr alguém na equipe, o
--    proprietário (ou admin) gera um link com o nível de acesso; quem
--    abre o link cria a conta (o tipo vem da empresa) e já está dentro.
--  * O link é um segredo de 64 caracteres (dois UUID v4 aleatórios), de
--    uso único, válido por 7 dias e revogável. Quem tem o link entra:
--    é o modelo pedido; por isso só owner/admin geram e veem os links.
--  * Uma conta, uma empresa: quem abre o link já tendo uma empresa só
--    vazia (sozinho, sem produtos, pedidos nem conexões — a criada
--    automaticamente) troca por esta; com dados, o link é recusado.
-- =====================================================================

alter table public.organization_invitations
  alter column email drop not null,
  add column token text unique check (token is null or token ~ '^[0-9a-f]{64}$'),
  add column label text check (label is null or char_length(label) between 1 and 60),
  add constraint organization_invitations_email_or_token check (email is not null or token is not null);

/** Gera um link de convite (owner convida admin/membro; admin convida membro). Devolve o segredo. */
create function public.create_invite_link(p_org uuid, p_role public.org_role, p_label text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller public.org_role := private.org_role_of(p_org);
  v_token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_label text := nullif(btrim(coalesce(p_label, '')), '');
begin
  if v_caller is null or v_caller = 'member' then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  if p_role is null or p_role = 'owner' or (p_role = 'admin' and v_caller <> 'owner') then
    raise exception 'org.invalid_role' using errcode = '42501';
  end if;
  if (
    select count(*) from public.organization_invitations i
    where i.organization_id = p_org and i.expires_at > now()
  ) >= 100 then
    raise exception 'org.limit_reached';
  end if;

  insert into public.organization_invitations (organization_id, role, invited_by, token, label)
  values (p_org, p_role, auth.uid(), v_token, left(v_label, 60));
  return v_token;
end;
$$;

/** O que o link oferece (tela do convite, antes de criar a conta). Nulo = inválido ou vencido. */
create function public.invite_link_preview(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'organization_name', o.name,
    'kind', o.kind,
    'role', i.role,
    'expires_at', i.expires_at
  )
  from public.organization_invitations i
  join public.organizations o on o.id = i.organization_id
  where p_token ~ '^[0-9a-f]{64}$' and i.token = p_token and i.expires_at > now()
    and o.suspended_at is null
$$;

/** Empresa só da pessoa e sem nada dentro (a criada no primeiro acesso). */
create function private.is_empty_solo_org(p_org uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
      select 1 from public.organization_members m where m.organization_id = p_org and m.user_id <> p_user)
    and not exists (select 1 from public.products p where p.organization_id = p_org)
    and not exists (select 1 from public.orders o where o.organization_id = p_org)
    and not exists (select 1 from public.supplier_orders s where s.organization_id = p_org)
    and not exists (select 1 from public.integration_connections c where c.organization_id = p_org)
    and not exists (select 1 from public.ledger_entries e where e.organization_id = p_org)
$$;

/**
 * Entra na empresa do link (uso único). Erros: org.invitation_not_found,
 * org.account_type_mismatch, org.already_in_company.
 */
create function public.accept_invite_link(p_token text)
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
  r record;
begin
  if v_uid is null then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  select * into v_inv from public.organization_invitations i
  where p_token ~ '^[0-9a-f]{64}$' and i.token = p_token and i.expires_at > now()
  for update;
  if v_inv.id is null then
    raise exception 'org.invitation_not_found';
  end if;

  select o.kind into v_kind from public.organizations o
  where o.id = v_inv.organization_id and o.suspended_at is null for update;
  select p.role into v_account from public.profiles p where p.id = v_uid;
  if v_kind is null then
    raise exception 'org.invitation_not_found';
  end if;
  if v_account is null or v_account::text <> v_kind::text then
    raise exception 'org.account_type_mismatch';
  end if;

  -- Uma conta, uma empresa: só troca a vazia criada no primeiro acesso.
  for r in
    select m.organization_id from public.organization_members m
    where m.user_id = v_uid and m.organization_id <> v_inv.organization_id
  loop
    if not private.is_empty_solo_org(r.organization_id, v_uid) then
      raise exception 'org.already_in_company';
    end if;
  end loop;
  delete from public.organizations o
  where o.id in (
    select m.organization_id from public.organization_members m
    where m.user_id = v_uid and m.organization_id <> v_inv.organization_id
  );

  insert into public.organization_members (organization_id, user_id, role)
  values (v_inv.organization_id, v_uid, v_inv.role)
  on conflict (organization_id, user_id) do nothing;

  delete from public.organization_invitations where id = v_inv.id;
  return v_inv.organization_id;
end;
$$;

revoke execute on function public.create_invite_link(uuid, public.org_role, text) from public, anon;
revoke execute on function public.invite_link_preview(text) from public;
revoke execute on function private.is_empty_solo_org(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.accept_invite_link(text) from public, anon;

grant execute on function public.create_invite_link(uuid, public.org_role, text) to authenticated;
grant execute on function public.invite_link_preview(text) to anon, authenticated;
grant execute on function public.accept_invite_link(text) to authenticated;
