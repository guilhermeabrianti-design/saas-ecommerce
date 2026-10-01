-- =====================================================================
-- Organização automática no primeiro acesso
--
--  * Ninguém fica preso na tela "Criar organização": quem entra sem
--    nenhuma organização ganha uma na hora, do tipo da conta, com nome
--    provisório ("Loja de Ana" / "Fornecedor Ana Souza") — renomeável em
--    Organização. Quem quer entrar na de outra pessoa aceita o convite
--    depois e troca no seletor.
--  * Idempotente: duas chamadas ao mesmo tempo (abas, StrictMode) não
--    criam duas organizações.
--  * Código de indicação inválido ou programa pausado não impedem a
--    criação: a organização nasce sem indicação.
-- =====================================================================

create function public.ensure_my_organization(p_referral_code text default null)
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

  v_first := split_part(btrim(v_profile.full_name), ' ', 1);
  v_name := left(btrim(case v_profile.role
    when 'supplier' then 'Fornecedor ' || btrim(v_profile.full_name)
    else 'Loja de ' || v_first
  end), 80);

  begin
    return public.create_organization(v_name, p_referral_code);
  exception when others then
    if sqlerrm not like 'referral.%' then
      raise;
    end if;
  end;
  return public.create_organization(v_name, null);
end;
$$;

revoke execute on function public.ensure_my_organization(text) from public, anon;
grant execute on function public.ensure_my_organization(text) to authenticated;
