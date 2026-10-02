-- =====================================================================
-- Indique e ganhe: código de indicação guardado na conta
--
--  * O link de indicação (/cadastro?indicacao=<código>) guardava o código
--    só no navegador. Quem confirmava o e-mail em outro aparelho (o
--    celular, por exemplo) perdia a indicação.
--  * Agora o cadastro também grava `referral_code` nos dados da conta, e a
--    criação automática da empresa usa esse código quando o navegador não
--    tem nenhum. Código inválido ou programa pausado continuam não
--    impedindo a criação da empresa.
-- =====================================================================

create or replace function public.ensure_my_organization(p_referral_code text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_existing uuid;
  v_first text;
  v_name text;
  v_code text := nullif(btrim(coalesce(p_referral_code, '')), '');
begin
  if v_uid is null then
    raise exception 'org.forbidden' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ensure-org:' || v_uid::text, 0));

  select m.organization_id into v_existing
  from public.organization_members m where m.user_id = v_uid
  order by m.created_at limit 1;
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_profile from public.profiles p where p.id = v_uid;
  if v_profile.id is null or v_profile.role = 'admin' then
    raise exception 'org.account_type_not_allowed' using errcode = '42501';
  end if;

  -- Sem código no navegador: o que veio do link de indicação no cadastro.
  if v_code is null then
    select left(nullif(btrim(u.raw_user_meta_data ->> 'referral_code'), ''), 64) into v_code
    from auth.users u where u.id = v_uid;
  end if;

  v_first := split_part(btrim(v_profile.full_name), ' ', 1);
  v_name := left(btrim(case v_profile.role
    when 'supplier' then 'Fornecedor ' || btrim(v_profile.full_name)
    else 'Loja de ' || v_first
  end), 80);

  begin
    return public.create_organization(v_name, v_code);
  exception when others then
    if sqlerrm not like 'referral.%' then
      raise;
    end if;
  end;
  return public.create_organization(v_name, null);
end;
$$;
