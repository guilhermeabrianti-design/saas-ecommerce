-- =====================================================================
-- Fase 17 · Academia
--
--  * Cursos → módulos → aulas. Vídeo hospedado no YouTube: a aula guarda só
--    o id do vídeo (11 caracteres); o player oficial do YouTube o reproduz.
--  * Materiais: PDF/imagem no bucket privado `academy` ou link https.
--  * A equipe edita o conteúdo direto nas tabelas (policies só para ela).
--    Alunos (qualquer conta não-equipe) NUNCA leem as tabelas: usam RPCs
--    que respeitam publicação, público-alvo e regras de liberação — o id do
--    vídeo e os materiais de aula bloqueada não saem do banco.
--  * Liberação: livre, após a aula anterior, após o módulo anterior ou por
--    aprovação da equipe (liberação por plano chega com os planos).
--  * Progresso por aula (posição para "continuar de onde parou", % e
--    conclusão; 90% assistidos concluem sozinho). Curso concluído = todas
--    as aulas obrigatórias (ou todas, se nenhuma for obrigatória).
--  * Certificado com código, quando o curso permite; a equipe também emite.
--  * Perguntas por aula, respondidas pela equipe.
-- =====================================================================

create type public.course_level as enum ('beginner', 'intermediate', 'advanced');
create type public.course_status as enum ('draft', 'published', 'archived');
create type public.course_audience as enum ('all', 'seller', 'supplier');
create type public.lesson_unlock_rule as enum ('none', 'previous_lesson', 'previous_module', 'admin_approval');
create type public.material_kind as enum ('file', 'link');

-- Usado nas policies de conteúdo da Academia (só informa se QUEM CHAMA é da equipe).
grant execute on function private.is_platform_admin() to authenticated;

-- ---------------------------------------------------------------------
-- Conteúdo
-- ---------------------------------------------------------------------
create table public.academy_courses (
  id uuid primary key default gen_random_uuid(),
  title text not null check (title = btrim(title) and char_length(title) between 3 and 120),
  description text not null default '' check (char_length(description) <= 5000),
  level public.course_level not null default 'beginner',
  status public.course_status not null default 'draft',
  audience public.course_audience not null default 'all',
  cover_path text,
  certificate_enabled boolean not null default false,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cover_path is null or (
    cover_path ~ '^covers/[0-9a-f-]{36}/[^/]{1,120}$' and split_part(cover_path, '/', 2) = id::text
  ))
);

create table public.academy_modules (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.academy_courses (id) on delete cascade,
  title text not null check (title = btrim(title) and char_length(title) between 3 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (course_id, id)
);

create index academy_modules_course_idx on public.academy_modules (course_id, position);

create table public.academy_lessons (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null,
  module_id uuid not null,
  title text not null check (title = btrim(title) and char_length(title) between 3 and 120),
  description text not null default '' check (char_length(description) <= 5000),
  youtube_id text check (youtube_id is null or youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
  duration_seconds integer not null default 0 check (duration_seconds between 0 and 86400),
  is_required boolean not null default true,
  unlock_rule public.lesson_unlock_rule not null default 'none',
  -- Botão "fazer agora": leva a uma tela interna do app.
  action_label text check (action_label is null or (action_label = btrim(action_label) and char_length(action_label) between 2 and 40)),
  action_path text check (action_path is null or action_path ~ '^/[a-z0-9/_-]{0,80}$'),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (course_id, module_id) references public.academy_modules (course_id, id) on delete cascade,
  check ((action_label is null) = (action_path is null))
);

create index academy_lessons_module_idx on public.academy_lessons (module_id, position);
create index academy_lessons_course_idx on public.academy_lessons (course_id);

create table public.academy_materials (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references public.academy_lessons (id) on delete cascade,
  kind public.material_kind not null,
  title text not null check (title = btrim(title) and char_length(title) between 2 and 120),
  storage_path text,
  url text check (url is null or (url ~ '^https://[^\s/$.?#][^\s]*$' and char_length(url) <= 2000)),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  check (
    (kind = 'file' and url is null and storage_path ~ '^materials/[0-9a-f-]{36}/[^/]{1,120}$'
      and split_part(storage_path, '/', 2) = lesson_id::text)
    or (kind = 'link' and storage_path is null and url is not null)
  )
);

create index academy_materials_lesson_idx on public.academy_materials (lesson_id, position);

create trigger academy_courses_set_updated_at before update on public.academy_courses
  for each row execute function public.set_updated_at();
create trigger academy_modules_set_updated_at before update on public.academy_modules
  for each row execute function public.set_updated_at();
create trigger academy_lessons_set_updated_at before update on public.academy_lessons
  for each row execute function public.set_updated_at();

-- Novo item entra no fim da lista do seu pai.
create function private.academy_append_position()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'academy_courses' then
    select coalesce(max(position) + 1, 0) into new.position from public.academy_courses;
  elsif tg_table_name = 'academy_modules' then
    select coalesce(max(position) + 1, 0) into new.position
    from public.academy_modules where course_id = new.course_id;
  elsif tg_table_name = 'academy_lessons' then
    select coalesce(max(position) + 1, 0) into new.position
    from public.academy_lessons where module_id = new.module_id;
  else
    select coalesce(max(position) + 1, 0) into new.position
    from public.academy_materials where lesson_id = new.lesson_id;
  end if;
  return new;
end;
$$;

create trigger academy_courses_position before insert on public.academy_courses
  for each row execute function private.academy_append_position();
create trigger academy_modules_position before insert on public.academy_modules
  for each row execute function private.academy_append_position();
create trigger academy_lessons_position before insert on public.academy_lessons
  for each row execute function private.academy_append_position();
create trigger academy_materials_position before insert on public.academy_materials
  for each row execute function private.academy_append_position();

-- Conteúdo: só a equipe, direto nas tabelas. Alunos usam as RPCs.
do $$
declare
  t text;
begin
  foreach t in array array['academy_courses', 'academy_modules', 'academy_lessons', 'academy_materials'] loop
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "%s: equipe gerencia" on public.%I for all to authenticated
                    using (private.is_platform_admin()) with check (private.is_platform_admin())', t, t);
  end loop;
end;
$$;

grant select, insert, delete on table public.academy_courses to authenticated;
grant update (title, description, level, status, audience, cover_path, certificate_enabled)
  on table public.academy_courses to authenticated;
grant select, insert, delete on table public.academy_modules to authenticated;
grant update (title, description) on table public.academy_modules to authenticated;
grant select, insert, delete on table public.academy_lessons to authenticated;
grant update (title, description, youtube_id, duration_seconds, is_required, unlock_rule, action_label, action_path)
  on table public.academy_lessons to authenticated;
grant select, insert, delete on table public.academy_materials to authenticated;
grant update (title) on table public.academy_materials to authenticated;

-- ---------------------------------------------------------------------
-- Dados dos alunos (sem acesso direto: só RPCs)
-- ---------------------------------------------------------------------
create table public.academy_progress (
  user_id uuid not null references auth.users (id) on delete cascade,
  lesson_id uuid not null references public.academy_lessons (id) on delete cascade,
  position_seconds integer not null default 0 check (position_seconds between 0 and 86400),
  percent smallint not null default 0 check (percent between 0 and 100),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, lesson_id)
);

create index academy_progress_lesson_idx on public.academy_progress (lesson_id);

create table public.academy_unlocks (
  user_id uuid not null references auth.users (id) on delete cascade,
  lesson_id uuid not null references public.academy_lessons (id) on delete cascade,
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid,
  primary key (user_id, lesson_id)
);

create index academy_unlocks_pending_idx on public.academy_unlocks (requested_at) where approved_at is null;

create table public.academy_certificates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid references public.academy_courses (id) on delete set null,
  code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
  holder_name text not null,
  course_title text not null,
  course_hours numeric(6, 1) not null default 0,
  issued_by uuid,
  issued_at timestamptz not null default now()
);

create unique index academy_certificates_user_course_key
  on public.academy_certificates (user_id, course_id) where course_id is not null;

create table public.academy_questions (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references public.academy_lessons (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  body text not null check (body = btrim(body) and char_length(body) between 3 and 2000),
  answer text check (answer is null or (answer = btrim(answer) and char_length(answer) between 2 and 4000)),
  answered_at timestamptz,
  answered_by uuid,
  created_at timestamptz not null default now()
);

create index academy_questions_lesson_idx on public.academy_questions (lesson_id, created_at);
create index academy_questions_open_idx on public.academy_questions (created_at) where answer is null;

do $$
declare
  t text;
begin
  foreach t in array array['academy_progress', 'academy_unlocks', 'academy_certificates', 'academy_questions'] loop
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- Storage: capas e materiais
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('academy', 'academy', false, 20971520,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Regras (internas)
-- ---------------------------------------------------------------------

/** Curso publicado para o público de quem chama (a equipe vê todos). */
create function private.academy_course_visible(p_course uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_platform_admin() or exists (
    select 1 from public.academy_courses c
    join public.profiles p on p.id = (select auth.uid())
    where c.id = p_course and c.status = 'published'
      and (c.audience = 'all' or c.audience::text = p.role::text)
  )
$$;

/** Aulas do curso na ordem de estudo. */
create function private.academy_lesson_order(p_course uuid)
returns table (lesson_id uuid, module_id uuid, module_ord bigint, ord bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id, l.module_id,
    dense_rank() over (order by m.position, m.created_at, m.id),
    row_number() over (order by m.position, m.created_at, m.id, l.position, l.created_at, l.id)
  from public.academy_lessons l
  join public.academy_modules m on m.id = l.module_id
  where l.course_id = p_course
$$;

create function private.academy_done(p_user uuid, p_lesson uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.academy_progress pr
    where pr.user_id = p_user and pr.lesson_id = p_lesson and pr.completed_at is not null
  )
$$;

create function private.academy_unlocked(p_user uuid, p_lesson uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lesson public.academy_lessons%rowtype;
  v_ord bigint;
  v_module_ord bigint;
begin
  select * into v_lesson from public.academy_lessons l where l.id = p_lesson;
  if v_lesson.id is null then
    return false;
  end if;

  if v_lesson.unlock_rule = 'none' then
    return true;
  elsif v_lesson.unlock_rule = 'admin_approval' then
    return exists (
      select 1 from public.academy_unlocks u
      where u.user_id = p_user and u.lesson_id = p_lesson and u.approved_at is not null
    );
  end if;

  select o.ord, o.module_ord into v_ord, v_module_ord
  from private.academy_lesson_order(v_lesson.course_id) o where o.lesson_id = p_lesson;

  if v_lesson.unlock_rule = 'previous_lesson' then
    return not exists (
      select 1 from private.academy_lesson_order(v_lesson.course_id) o
      where o.ord = v_ord - 1 and not private.academy_done(p_user, o.lesson_id)
    );
  end if;

  -- previous_module: aulas obrigatórias do módulo anterior concluídas.
  return not exists (
    select 1 from private.academy_lesson_order(v_lesson.course_id) o
    join public.academy_lessons l on l.id = o.lesson_id
    where o.module_ord = v_module_ord - 1 and l.is_required
      and not private.academy_done(p_user, o.lesson_id)
  );
end;
$$;

/** Aula de curso visível e liberada para quem chama; senão, erro estável. */
create function private.academy_require_lesson(p_lesson uuid)
returns public.academy_lessons
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lesson public.academy_lessons%rowtype;
begin
  select * into v_lesson from public.academy_lessons l where l.id = p_lesson;
  if v_lesson.id is null or not private.academy_course_visible(v_lesson.course_id) then
    raise exception 'academy.not_found';
  end if;
  if not private.is_platform_admin() and not private.academy_unlocked(auth.uid(), p_lesson) then
    raise exception 'academy.locked';
  end if;
  return v_lesson;
end;
$$;

/** Resumo de progresso de um aluno num curso. */
create function private.academy_summary(p_user uuid, p_course uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with lessons as (
    select l.id, l.module_id, l.is_required, private.academy_done(p_user, l.id) as done
    from public.academy_lessons l where l.course_id = p_course
  ),
  modules as (
    select m.id,
      coalesce(bool_and(ls.done), false) and count(ls.id) > 0 as done
    from public.academy_modules m
    left join lessons ls on ls.module_id = m.id
    where m.course_id = p_course
    group by m.id
  ),
  req as (
    select case when exists (select 1 from lessons where is_required)
      then (select bool_and(done) from lessons where is_required)
      else coalesce((select bool_and(done) from lessons), false) end as completed
  )
  select jsonb_build_object(
    'lessons_total', (select count(*) from lessons),
    'lessons_done', (select count(*) from lessons where done),
    'modules_total', (select count(*) from modules),
    'modules_done', (select count(*) from modules where done),
    'percent', case when (select count(*) from lessons) = 0 then 0
      else ((select count(*) from lessons where done) * 100 / (select count(*) from lessons))::integer end,
    'completed', (select count(*) from lessons) > 0 and (select completed from req)
  )
$$;

-- ---------------------------------------------------------------------
-- RPCs do aluno
-- ---------------------------------------------------------------------
create function public.academy_catalog()
returns table (
  id uuid,
  title text,
  description text,
  level public.course_level,
  cover_path text,
  certificate_enabled boolean,
  modules bigint,
  lessons bigint,
  duration_seconds bigint,
  lessons_done bigint,
  percent integer,
  completed boolean,
  certificate_id uuid,
  last_activity timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'academy.forbidden' using errcode = '42501';
  end if;
  return query
  select c.id, c.title, c.description, c.level, c.cover_path, c.certificate_enabled,
    (select count(*) from public.academy_modules m where m.course_id = c.id),
    (s ->> 'lessons_total')::bigint,
    (select coalesce(sum(l.duration_seconds), 0)::bigint from public.academy_lessons l where l.course_id = c.id),
    (s ->> 'lessons_done')::bigint,
    (s ->> 'percent')::integer,
    (s ->> 'completed')::boolean,
    (select ce.id from public.academy_certificates ce where ce.user_id = v_uid and ce.course_id = c.id),
    (select max(pr.updated_at) from public.academy_progress pr
     join public.academy_lessons l on l.id = pr.lesson_id
     where pr.user_id = v_uid and l.course_id = c.id)
  from public.academy_courses c
  cross join lateral private.academy_summary(v_uid, c.id) s
  where c.status = 'published' and private.academy_course_visible(c.id)
  order by c.position, c.created_at, c.id;
end;
$$;

create function public.academy_course(p_course uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_course public.academy_courses%rowtype;
  v_resume uuid;
begin
  select * into v_course from public.academy_courses c where c.id = p_course;
  if v_course.id is null or v_uid is null or not private.academy_course_visible(p_course) then
    raise exception 'academy.not_found';
  end if;

  -- Continuar: a aula iniciada mais recente ainda não concluída; senão a
  -- primeira aula liberada não concluída.
  select pr.lesson_id into v_resume
  from public.academy_progress pr
  join public.academy_lessons l on l.id = pr.lesson_id
  where pr.user_id = v_uid and l.course_id = p_course and pr.completed_at is null
  order by pr.updated_at desc limit 1;
  if v_resume is null then
    select o.lesson_id into v_resume
    from private.academy_lesson_order(p_course) o
    where not private.academy_done(v_uid, o.lesson_id) and private.academy_unlocked(v_uid, o.lesson_id)
    order by o.ord limit 1;
  end if;

  return jsonb_build_object(
    'id', v_course.id,
    'title', v_course.title,
    'description', v_course.description,
    'level', v_course.level,
    'cover_path', v_course.cover_path,
    'certificate_enabled', v_course.certificate_enabled,
    'summary', private.academy_summary(v_uid, p_course),
    'resume_lesson_id', v_resume,
    'certificate_id', (select ce.id from public.academy_certificates ce
                       where ce.user_id = v_uid and ce.course_id = p_course),
    'modules', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id,
        'title', m.title,
        'description', m.description,
        'lessons', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', l.id,
            'title', l.title,
            'duration_seconds', l.duration_seconds,
            'is_required', l.is_required,
            'unlock_rule', l.unlock_rule,
            'unlocked', private.academy_unlocked(v_uid, l.id),
            'unlock_requested', exists (select 1 from public.academy_unlocks u
                                        where u.user_id = v_uid and u.lesson_id = l.id),
            'completed', pr.completed_at is not null,
            'percent', coalesce(pr.percent, 0)
          ) order by l.position, l.created_at, l.id)
          from public.academy_lessons l
          left join public.academy_progress pr on pr.lesson_id = l.id and pr.user_id = v_uid
          where l.module_id = m.id
        ), '[]'::jsonb)
      ) order by m.position, m.created_at, m.id)
      from public.academy_modules m where m.course_id = p_course
    ), '[]'::jsonb)
  );
end;
$$;

create function public.academy_lesson(p_lesson uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_lesson public.academy_lessons%rowtype;
  v_ord bigint;
  v_prev uuid;
  v_next uuid;
begin
  v_lesson := private.academy_require_lesson(p_lesson);
  select o.ord into v_ord from private.academy_lesson_order(v_lesson.course_id) o where o.lesson_id = p_lesson;
  select o.lesson_id into v_prev from private.academy_lesson_order(v_lesson.course_id) o where o.ord = v_ord - 1;
  select o.lesson_id into v_next from private.academy_lesson_order(v_lesson.course_id) o where o.ord = v_ord + 1;

  return jsonb_build_object(
    'id', v_lesson.id,
    'title', v_lesson.title,
    'description', v_lesson.description,
    'youtube_id', v_lesson.youtube_id,
    'duration_seconds', v_lesson.duration_seconds,
    'is_required', v_lesson.is_required,
    'action_label', v_lesson.action_label,
    'action_path', v_lesson.action_path,
    'course_id', v_lesson.course_id,
    'course_title', (select c.title from public.academy_courses c where c.id = v_lesson.course_id),
    'module_title', (select m.title from public.academy_modules m where m.id = v_lesson.module_id),
    'prev_lesson_id', v_prev,
    'next_lesson_id', v_next,
    'next_unlocked', v_next is not null and (private.is_platform_admin() or private.academy_unlocked(v_uid, v_next)),
    'progress', (select jsonb_build_object('position_seconds', pr.position_seconds, 'percent', pr.percent,
                                           'completed', pr.completed_at is not null)
                 from public.academy_progress pr where pr.user_id = v_uid and pr.lesson_id = p_lesson),
    'materials', coalesce((
      select jsonb_agg(jsonb_build_object('id', ma.id, 'kind', ma.kind, 'title', ma.title,
                                          'storage_path', ma.storage_path, 'url', ma.url)
                       order by ma.position, ma.created_at)
      from public.academy_materials ma where ma.lesson_id = p_lesson
    ), '[]'::jsonb)
  );
end;
$$;

/** Salva a posição do player; 90% assistidos concluem a aula. */
create function public.academy_save_progress(p_lesson uuid, p_position_seconds integer, p_duration_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_percent smallint;
  v_row public.academy_progress%rowtype;
begin
  if p_position_seconds is null or p_position_seconds not between 0 and 86400
     or p_duration_seconds is null or p_duration_seconds not between 1 and 86400 then
    raise exception 'academy.invalid';
  end if;
  perform private.academy_require_lesson(p_lesson);
  v_percent := least(100, (least(p_position_seconds, p_duration_seconds) * 100) / p_duration_seconds);

  insert into public.academy_progress as pr (user_id, lesson_id, position_seconds, percent, completed_at)
  values (v_uid, p_lesson, p_position_seconds, v_percent, case when v_percent >= 90 then now() end)
  on conflict (user_id, lesson_id) do update set
    position_seconds = excluded.position_seconds,
    percent = greatest(pr.percent, excluded.percent),
    completed_at = coalesce(pr.completed_at, excluded.completed_at),
    updated_at = now()
  returning * into v_row;

  return jsonb_build_object('percent', v_row.percent, 'completed', v_row.completed_at is not null);
end;
$$;

create function public.academy_set_completed(p_lesson uuid, p_completed boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_completed is null then
    raise exception 'academy.invalid';
  end if;
  perform private.academy_require_lesson(p_lesson);
  insert into public.academy_progress as pr (user_id, lesson_id, percent, completed_at)
  values (auth.uid(), p_lesson, case when p_completed then 100 else 0 end,
          case when p_completed then now() end)
  on conflict (user_id, lesson_id) do update set
    completed_at = case when p_completed then coalesce(pr.completed_at, now()) end,
    percent = case when p_completed then 100 else pr.percent end,
    updated_at = now();
end;
$$;

create function public.academy_request_unlock(p_lesson uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lesson public.academy_lessons%rowtype;
begin
  select * into v_lesson from public.academy_lessons l where l.id = p_lesson;
  if v_lesson.id is null or auth.uid() is null or not private.academy_course_visible(v_lesson.course_id) then
    raise exception 'academy.not_found';
  end if;
  if v_lesson.unlock_rule <> 'admin_approval' then
    raise exception 'academy.invalid';
  end if;
  insert into public.academy_unlocks (user_id, lesson_id) values (auth.uid(), p_lesson)
  on conflict (user_id, lesson_id) do nothing;
end;
$$;

create function private.academy_issue(p_user uuid, p_course uuid, p_issuer uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_course public.academy_courses%rowtype;
begin
  select ce.id into v_id from public.academy_certificates ce
  where ce.user_id = p_user and ce.course_id = p_course;
  if v_id is not null then
    return v_id;
  end if;
  select * into v_course from public.academy_courses c where c.id = p_course;
  insert into public.academy_certificates (user_id, course_id, holder_name, course_title, course_hours, issued_by)
  values (
    p_user, p_course,
    (select p.full_name from public.profiles p where p.id = p_user),
    v_course.title,
    round((select coalesce(sum(l.duration_seconds), 0) from public.academy_lessons l
           where l.course_id = p_course) / 3600.0, 1),
    p_issuer
  )
  returning id into v_id;
  return v_id;
end;
$$;

/** Emite (ou devolve) o certificado de quem concluiu um curso com certificado habilitado. */
create function public.academy_claim_certificate(p_course uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not private.academy_course_visible(p_course) then
    raise exception 'academy.not_found';
  end if;
  if not exists (select 1 from public.academy_courses c where c.id = p_course and c.certificate_enabled) then
    raise exception 'academy.certificate_disabled';
  end if;
  if not (private.academy_summary(v_uid, p_course) ->> 'completed')::boolean then
    raise exception 'academy.not_completed';
  end if;
  return private.academy_issue(v_uid, p_course, null);
end;
$$;

create function public.academy_certificate(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row public.academy_certificates%rowtype;
begin
  select * into v_row from public.academy_certificates ce where ce.id = p_id;
  if v_row.id is null or (v_row.user_id is distinct from auth.uid() and not private.is_platform_admin()) then
    raise exception 'academy.not_found';
  end if;
  return jsonb_build_object(
    'id', v_row.id, 'code', v_row.code, 'holder_name', v_row.holder_name,
    'course_title', v_row.course_title, 'course_hours', v_row.course_hours,
    'issued_at', v_row.issued_at
  );
end;
$$;

create function public.academy_lesson_questions(p_lesson uuid)
returns table (
  id uuid,
  author_name text,
  is_mine boolean,
  body text,
  answer text,
  answered_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.academy_require_lesson(p_lesson);
  return query
  select q.id,
    -- Só o primeiro nome de outros alunos.
    split_part(coalesce(p.full_name, 'Aluno'), ' ', 1),
    q.user_id = auth.uid(), q.body, q.answer, q.answered_at, q.created_at
  from public.academy_questions q
  left join public.profiles p on p.id = q.user_id
  where q.lesson_id = p_lesson
  order by q.created_at desc, q.id
  limit 100;
end;
$$;

create function public.academy_ask(p_lesson uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  perform private.academy_require_lesson(p_lesson);
  if char_length(v_body) not between 3 and 2000 then
    raise exception 'academy.invalid';
  end if;
  if (select count(*) from public.academy_questions q
      where q.user_id = auth.uid() and q.created_at > now() - interval '1 day') >= 20 then
    raise exception 'academy.limit_reached';
  end if;
  insert into public.academy_questions (lesson_id, user_id, body)
  values (p_lesson, auth.uid(), v_body) returning id into v_id;
  return v_id;
end;
$$;

create function public.academy_delete_question(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.academy_questions q
  where q.id = p_id and (q.user_id = auth.uid() or private.is_platform_admin());
  if not found then
    raise exception 'academy.not_found';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- RPCs da equipe
-- ---------------------------------------------------------------------
create function public.admin_academy_students(p_course uuid, p_limit integer, p_offset integer)
returns table (
  user_id uuid,
  full_name text,
  email text,
  lessons_done bigint,
  lessons_total bigint,
  percent integer,
  completed boolean,
  last_activity timestamptz,
  certificate_id uuid,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return query
  with students as (
    select pr.user_id, max(pr.updated_at) as last_activity
    from public.academy_progress pr
    join public.academy_lessons l on l.id = pr.lesson_id
    where l.course_id = p_course
    group by pr.user_id
  )
  select s.user_id, p.full_name, u.email::text,
    (sm ->> 'lessons_done')::bigint, (sm ->> 'lessons_total')::bigint,
    (sm ->> 'percent')::integer, (sm ->> 'completed')::boolean,
    s.last_activity,
    (select ce.id from public.academy_certificates ce where ce.user_id = s.user_id and ce.course_id = p_course),
    count(*) over ()
  from students s
  join public.profiles p on p.id = s.user_id
  join auth.users u on u.id = s.user_id
  cross join lateral private.academy_summary(s.user_id, p_course) sm
  order by s.last_activity desc, s.user_id
  limit greatest(least(coalesce(p_limit, 25), 100), 1)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

create function public.admin_academy_unlock_requests()
returns table (
  user_id uuid,
  full_name text,
  email text,
  lesson_id uuid,
  lesson_title text,
  course_title text,
  requested_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return query
  select un.user_id, p.full_name, us.email::text, l.id, l.title, c.title, un.requested_at
  from public.academy_unlocks un
  join public.academy_lessons l on l.id = un.lesson_id
  join public.academy_courses c on c.id = l.course_id
  join public.profiles p on p.id = un.user_id
  join auth.users us on us.id = un.user_id
  where un.approved_at is null
  order by un.requested_at
  limit 200;
end;
$$;

/** Libera uma aula de aprovação para um aluno (com ou sem pedido prévio). */
create function public.admin_approve_unlock(p_user uuid, p_lesson uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  if not exists (select 1 from public.academy_lessons l where l.id = p_lesson)
     or not exists (select 1 from public.profiles p where p.id = p_user) then
    raise exception 'academy.not_found';
  end if;
  insert into public.academy_unlocks as un (user_id, lesson_id, approved_at, approved_by)
  values (p_user, p_lesson, now(), auth.uid())
  on conflict (user_id, lesson_id) do update
    set approved_at = coalesce(un.approved_at, now()), approved_by = coalesce(un.approved_by, auth.uid());
end;
$$;

create function public.admin_issue_certificate(p_user uuid, p_course uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_platform_admin();
  if not exists (select 1 from public.academy_courses c where c.id = p_course)
     or not exists (select 1 from public.profiles p where p.id = p_user and p.role <> 'admin') then
    raise exception 'academy.not_found';
  end if;
  v_id := private.academy_issue(p_user, p_course, auth.uid());
  perform private.audit('academy.certificate_issued', null,
    (select p.full_name from public.profiles p where p.id = p_user) || ' · '
      || (select c.title from public.academy_courses c where c.id = p_course),
    jsonb_build_object('certificate_id', v_id, 'user_id', p_user, 'course_id', p_course));
  return v_id;
end;
$$;

create function public.admin_academy_questions(p_open_only boolean, p_limit integer, p_offset integer)
returns table (
  id uuid,
  author_name text,
  author_email text,
  lesson_id uuid,
  lesson_title text,
  course_title text,
  body text,
  answer text,
  created_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return query
  select q.id, p.full_name, u.email::text, l.id, l.title, c.title, q.body, q.answer, q.created_at,
    count(*) over ()
  from public.academy_questions q
  join public.academy_lessons l on l.id = q.lesson_id
  join public.academy_courses c on c.id = l.course_id
  left join public.profiles p on p.id = q.user_id
  left join auth.users u on u.id = q.user_id
  where not coalesce(p_open_only, false) or q.answer is null
  order by q.created_at, q.id
  limit greatest(least(coalesce(p_limit, 25), 100), 1)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

create function public.admin_answer_question(p_id uuid, p_answer text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_answer text := btrim(coalesce(p_answer, ''));
begin
  perform private.require_platform_admin();
  if char_length(v_answer) not between 2 and 4000 then
    raise exception 'academy.invalid';
  end if;
  update public.academy_questions
  set answer = v_answer, answered_at = now(), answered_by = auth.uid()
  where id = p_id;
  if not found then
    raise exception 'academy.not_found';
  end if;
end;
$$;

/** Move curso/módulo/aula/material uma posição para cima (-1) ou para baixo (+1). */
create function public.admin_move_academy_item(p_kind text, p_id uuid, p_direction integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_col text;
  v_table text;
  v_parent uuid;
  v_ids uuid[];
  v_idx integer;
  v_swap integer;
  v_tmp uuid;
begin
  perform private.require_platform_admin();
  if p_direction not in (-1, 1) then
    raise exception 'academy.invalid';
  end if;
  case p_kind
    when 'course' then v_table := 'academy_courses'; v_parent_col := null;
    when 'module' then v_table := 'academy_modules'; v_parent_col := 'course_id';
    when 'lesson' then v_table := 'academy_lessons'; v_parent_col := 'module_id';
    when 'material' then v_table := 'academy_materials'; v_parent_col := 'lesson_id';
    else raise exception 'academy.invalid';
  end case;

  if v_parent_col is not null then
    execute format('select %I from public.%I where id = $1', v_parent_col, v_table)
      into v_parent using p_id;
    if v_parent is null then
      raise exception 'academy.not_found';
    end if;
    execute format(
      'select array_agg(id order by position, created_at, id) from public.%I where %I = $1',
      v_table, v_parent_col) into v_ids using v_parent;
  else
    execute format('select array_agg(id order by position, created_at, id) from public.%I', v_table)
      into v_ids;
  end if;

  v_idx := array_position(v_ids, p_id);
  if v_idx is null then
    raise exception 'academy.not_found';
  end if;
  v_swap := v_idx + p_direction;
  if v_swap < 1 or v_swap > array_length(v_ids, 1) then
    return;
  end if;
  v_tmp := v_ids[v_idx];
  v_ids[v_idx] := v_ids[v_swap];
  v_ids[v_swap] := v_tmp;
  execute format(
    'update public.%I t set position = s.ord - 1
     from unnest($1::uuid[]) with ordinality s(id, ord) where t.id = s.id', v_table)
    using v_ids;
end;
$$;

-- ---------------------------------------------------------------------
-- Storage: equipe gerencia; aluno lê capa de curso visível e material de
-- aula liberada.
-- ---------------------------------------------------------------------
create function private.academy_file_readable(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_platform_admin()
    or exists (
      select 1 from public.academy_courses c
      where c.cover_path = p_name and c.status = 'published' and private.academy_course_visible(c.id)
    )
    or exists (
      select 1 from public.academy_materials ma
      join public.academy_lessons l on l.id = ma.lesson_id
      where ma.storage_path = p_name
        and private.academy_course_visible(l.course_id)
        and private.academy_unlocked((select auth.uid()), l.id)
    )
$$;

grant execute on function private.academy_file_readable(text) to authenticated;

create policy "academy: leitura conforme curso e liberação"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'academy' and private.academy_file_readable(name));

create policy "academy: equipe envia"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'academy' and private.is_platform_admin());

create policy "academy: equipe exclui"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'academy' and private.is_platform_admin());

grant execute on function public.academy_catalog() to authenticated;
grant execute on function public.academy_course(uuid) to authenticated;
grant execute on function public.academy_lesson(uuid) to authenticated;
grant execute on function public.academy_save_progress(uuid, integer, integer) to authenticated;
grant execute on function public.academy_set_completed(uuid, boolean) to authenticated;
grant execute on function public.academy_request_unlock(uuid) to authenticated;
grant execute on function public.academy_claim_certificate(uuid) to authenticated;
grant execute on function public.academy_certificate(uuid) to authenticated;
grant execute on function public.academy_lesson_questions(uuid) to authenticated;
grant execute on function public.academy_ask(uuid, text) to authenticated;
grant execute on function public.academy_delete_question(uuid) to authenticated;
grant execute on function public.admin_academy_students(uuid, integer, integer) to authenticated;
grant execute on function public.admin_academy_unlock_requests() to authenticated;
grant execute on function public.admin_approve_unlock(uuid, uuid) to authenticated;
grant execute on function public.admin_issue_certificate(uuid, uuid) to authenticated;
grant execute on function public.admin_academy_questions(boolean, integer, integer) to authenticated;
grant execute on function public.admin_answer_question(uuid, text) to authenticated;
grant execute on function public.admin_move_academy_item(text, uuid, integer) to authenticated;
