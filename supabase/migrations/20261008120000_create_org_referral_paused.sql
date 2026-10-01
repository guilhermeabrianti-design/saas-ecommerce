-- =====================================================================
-- Criar organização com o programa de indicação pausado
-- ---------------------------------------------------------------------
-- Um código guardado por link de indicação não pode impedir o cadastro:
-- com o programa pausado, o código é ignorado e a organização é criada.
-- =====================================================================

create or replace function public.create_organization(p_name text, p_referral_code text default null)
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

  if private.normalize_public_code(p_referral_code) is not null
    and coalesce((select s.enabled from public.referral_settings s), false) then
    perform private.apply_referral(v_org, p_referral_code);
  end if;

  return v_org;
end;
$$;
