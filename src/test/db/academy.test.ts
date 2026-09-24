// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDatabase, signUpUser } from './supabase-sim';

let db: PGlite;
let admin: string;
let seller: string;
let seller2: string;
let supplier: string;
let course: string;
let m1: string;
let m2: string;
let l1: string;
let l2: string;
let l3: string;
let l4: string;

async function scalar<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return asUser(db, userId, async (tx) => {
    const res = await tx.query<Record<string, T>>(sql, params);
    return Object.values(res.rows[0] ?? {})[0] as T;
  });
}

async function rows<T>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, userId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

interface Outline {
  summary: {
    lessons_total: number;
    lessons_done: number;
    modules_total: number;
    modules_done: number;
    percent: number;
    completed: boolean;
  };
  resume_lesson_id: string | null;
  certificate_id: string | null;
  modules: { id: string; lessons: { id: string; unlocked: boolean; completed: boolean }[] }[];
}

const outline = (user = seller) =>
  scalar<Outline>(user, 'select public.academy_course($1)', [course]);
const lesson = (id: string, user = seller) =>
  scalar<{ youtube_id: string; next_lesson_id: string | null; progress: unknown }>(
    user,
    'select public.academy_lesson($1)',
    [id],
  );
const complete = (id: string, user = seller, done = true) =>
  scalar(user, 'select public.academy_set_completed($1, $2)', [id, done]);
const save = (id: string, pos: number, dur: number, user = seller) =>
  scalar<{ percent: number; completed: boolean }>(
    user,
    'select public.academy_save_progress($1, $2, $3)',
    [id, pos, dur],
  );
const unlocked = async (id: string, user = seller) =>
  (await outline(user)).modules.flatMap((m) => m.lessons).find((l) => l.id === id)!.unlocked;

const insert = (sql: string, params: unknown[]) => scalar<string>(admin, sql, params);

beforeEach(async () => {
  db = await createTestDatabase();
  admin = await signUpUser(db, 'staff@example.com', { full_name: 'Equipe' });
  await db.query("update public.profiles set role = 'admin' where id = $1", [admin]);
  seller = await signUpUser(db, 'ana@example.com', { full_name: 'Ana Souza' });
  seller2 = await signUpUser(db, 'bia@example.com', { full_name: 'Bia Lima' });
  supplier = await signUpUser(db, 'forn@example.com', {
    full_name: 'Fornecedor',
    account_type: 'supplier',
  });

  course = await insert(
    "insert into public.academy_courses (title, description, status) values ('Venda Sem Estoque', 'Do zero', 'published') returning id",
    [],
  );
  m1 = await insert(
    "insert into public.academy_modules (course_id, title) values ($1, 'Introdução ao Dropshipping') returning id",
    [course],
  );
  m2 = await insert(
    "insert into public.academy_modules (course_id, title) values ($1, 'Como encontrar produtos') returning id",
    [course],
  );
  const lessonSql = `insert into public.academy_lessons (course_id, module_id, title, youtube_id, duration_seconds, unlock_rule, is_required)
                     values ($1, $2, $3, $4, 600, $5, $6) returning id`;
  l1 = await insert(lessonSql, [course, m1, 'Boas-vindas', 'dQw4w9WgXcQ', 'none', true]);
  l2 = await insert(lessonSql, [
    course,
    m1,
    'O que é dropshipping',
    'aaaaaaaaaaa',
    'previous_lesson',
    true,
  ]);
  l3 = await insert(lessonSql, [
    course,
    m2,
    'Critérios de produto',
    'bbbbbbbbbbb',
    'previous_module',
    true,
  ]);
  l4 = await insert(lessonSql, [
    course,
    m2,
    'Mentoria fechada',
    'ccccccccccc',
    'admin_approval',
    false,
  ]);
});

afterEach(async () => {
  await db.close();
});

describe('academia: visibilidade', () => {
  it('rascunho e público-alvo controlam quem vê o curso', async () => {
    expect((await rows(seller, 'select id from public.academy_catalog()')).length).toBe(1);
    await scalar(admin, "update public.academy_courses set audience = 'seller' where id = $1", [
      course,
    ]);
    expect((await rows(supplier, 'select id from public.academy_catalog()')).length).toBe(0);
    await expect(outline(supplier)).rejects.toThrow(/academy.not_found/);
    await scalar(admin, "update public.academy_courses set status = 'draft' where id = $1", [
      course,
    ]);
    expect((await rows(seller, 'select id from public.academy_catalog()')).length).toBe(0);
    await expect(outline()).rejects.toThrow(/academy.not_found/);
    await expect(lesson(l1)).rejects.toThrow(/academy.not_found/);
    // A equipe continua vendo para editar/pré-visualizar.
    await outline(admin);
  });

  it('alunos não leem nem escrevem as tabelas; o esboço não expõe o vídeo', async () => {
    expect(await rows(seller, 'select * from public.academy_lessons')).toEqual([]);
    await expect(
      rows(seller, "insert into public.academy_courses (title) values ('Hack')"),
    ).rejects.toThrow(/row-level security|permission denied/);
    await expect(rows(seller, 'select * from public.academy_progress')).rejects.toThrow(
      /permission denied/,
    );
    expect(JSON.stringify(await outline())).not.toContain('youtube');
    expect((await lesson(l1)).youtube_id).toBe('dQw4w9WgXcQ');
  });

  it('catálogo resume módulos, aulas e duração', async () => {
    const [c] = await rows<{ modules: number; lessons: number; duration_seconds: number }>(
      seller,
      'select * from public.academy_catalog()',
    );
    expect(c).toMatchObject({ modules: 2, lessons: 4, duration_seconds: 2400 });
  });
});

describe('academia: liberação', () => {
  it('aula anterior, módulo anterior e aprovação da equipe', async () => {
    expect(await unlocked(l1)).toBe(true);
    expect(await unlocked(l2)).toBe(false);
    await expect(lesson(l2)).rejects.toThrow(/academy.locked/);
    await expect(save(l2, 10, 600)).rejects.toThrow(/academy.locked/);

    await complete(l1);
    expect(await unlocked(l2)).toBe(true);
    expect(await unlocked(l3)).toBe(false); // módulo 1 ainda incompleto
    await complete(l2);
    expect(await unlocked(l3)).toBe(true);

    expect(await unlocked(l4)).toBe(false);
    await expect(scalar(seller, 'select public.academy_request_unlock($1)', [l1])).rejects.toThrow(
      /academy.invalid/,
    );
    await scalar(seller, 'select public.academy_request_unlock($1)', [l4]);
    const requests = await rows<{ email: string; lesson_title: string }>(
      admin,
      'select * from public.admin_academy_unlock_requests()',
    );
    expect(requests).toMatchObject([
      { email: 'ana@example.com', lesson_title: 'Mentoria fechada' },
    ]);
    await scalar(admin, 'select public.admin_approve_unlock($1, $2)', [seller, l4]);
    expect(await unlocked(l4)).toBe(true);
    expect(await unlocked(l4, seller2)).toBe(false);
    expect(await rows(admin, 'select * from public.admin_academy_unlock_requests()')).toEqual([]);
  });

  it('reordenar muda qual é a aula anterior', async () => {
    await scalar(admin, "select public.admin_move_academy_item('lesson', $1, -1)", [l2]);
    // Agora l2 é a primeira do módulo e não tem anterior.
    expect(await unlocked(l2)).toBe(true);
    expect((await outline()).modules[0]!.lessons.map((l) => l.id)).toEqual([l2, l1]);
    await scalar(admin, "select public.admin_move_academy_item('module', $1, -1)", [m2]);
    expect((await outline()).modules.map((m) => m.id)).toEqual([m2, m1]);
    // Mover para fora da lista não faz nada.
    await scalar(admin, "select public.admin_move_academy_item('module', $1, -1)", [m2]);
    await expect(
      scalar(seller, "select public.admin_move_academy_item('module', $1, 1)", [m2]),
    ).rejects.toThrow(/admin.forbidden/);
  });
});

describe('academia: progresso', () => {
  it('continua de onde parou, guarda o maior % e conclui aos 90%', async () => {
    expect(await save(l1, 378, 600)).toEqual({ percent: 63, completed: false });
    const o = await outline();
    expect(o.resume_lesson_id).toBe(l1);
    expect(await lesson(l1)).toMatchObject({
      progress: { position_seconds: 378, percent: 63, completed: false },
    });
    // Voltou o vídeo: a posição muda, o % não cai.
    expect(await save(l1, 60, 600)).toEqual({ percent: 63, completed: false });
    expect(await save(l1, 545, 600)).toEqual({ percent: 90, completed: true });
    await expect(save(l1, -1, 600)).rejects.toThrow(/academy.invalid/);
    await expect(save(l1, 10, 0)).rejects.toThrow(/academy.invalid/);
    // Próxima aula liberada vira o "continuar".
    expect((await outline()).resume_lesson_id).toBe(l2);
  });

  it('resumo: aulas, módulos e percentual; desmarcar conclusão', async () => {
    await complete(l1);
    await complete(l2);
    let s = (await outline()).summary;
    expect(s).toEqual({
      lessons_total: 4,
      lessons_done: 2,
      modules_total: 2,
      modules_done: 1,
      percent: 50,
      completed: false,
    });
    await complete(l3);
    // l4 não é obrigatória: curso concluído mesmo sem ela.
    expect((await outline()).summary.completed).toBe(true);
    await complete(l3, seller, false);
    s = (await outline()).summary;
    expect(s.lessons_done).toBe(2);
    expect(s.completed).toBe(false);
  });

  it('a equipe acompanha os alunos', async () => {
    await complete(l1);
    await save(l1, 10, 600, seller2);
    const students = await rows<{ email: string; lessons_done: number; percent: number }>(
      admin,
      'select * from public.admin_academy_students($1, 10, 0)',
      [course],
    );
    expect(students).toHaveLength(2);
    expect(students.find((s) => s.email === 'ana@example.com')).toMatchObject({
      lessons_done: 1,
      percent: 25,
    });
    await expect(
      rows(seller, 'select * from public.admin_academy_students($1, 10, 0)', [course]),
    ).rejects.toThrow(/admin.forbidden/);
  });
});

describe('academia: certificados', () => {
  it('só com certificado habilitado e curso concluído; um por aluno', async () => {
    const claim = (user = seller) =>
      scalar<string>(user, 'select public.academy_claim_certificate($1)', [course]);
    await expect(claim()).rejects.toThrow(/academy.certificate_disabled/);
    await scalar(
      admin,
      'update public.academy_courses set certificate_enabled = true where id = $1',
      [course],
    );
    await expect(claim()).rejects.toThrow(/academy.not_completed/);
    for (const l of [l1, l2, l3]) await complete(l);
    const id = await claim();
    expect(await claim()).toBe(id);
    const cert = await scalar<{ holder_name: string; course_title: string; code: string }>(
      seller,
      'select public.academy_certificate($1)',
      [id],
    );
    expect(cert).toMatchObject({ holder_name: 'Ana Souza', course_title: 'Venda Sem Estoque' });
    expect(cert.code).toMatch(/^[0-9A-F]{12}$/);
    await expect(scalar(seller2, 'select public.academy_certificate($1)', [id])).rejects.toThrow(
      /academy.not_found/,
    );
    await scalar(admin, 'select public.academy_certificate($1)', [id]);

    // A equipe emite manualmente (auditado).
    const manual = await scalar<string>(admin, 'select public.admin_issue_certificate($1, $2)', [
      seller2,
      course,
    ]);
    expect(manual).toBeTruthy();
    expect(await scalar(admin, 'select action from public.admin_audit_entries(1, 0)')).toBe(
      'academy.certificate_issued',
    );
  });
});

describe('academia: perguntas', () => {
  it('pergunta em aula liberada; outros veem só o primeiro nome; equipe responde', async () => {
    await expect(
      scalar(seller, "select public.academy_ask($1, 'Posso pular?')", [l2]),
    ).rejects.toThrow(/academy.locked/);
    const q = await scalar<string>(seller, "select public.academy_ask($1, 'Como escolho?')", [l1]);
    const seen = await rows<{ author_name: string; is_mine: boolean }>(
      seller2,
      'select * from public.academy_lesson_questions($1)',
      [l1],
    );
    expect(seen).toMatchObject([{ author_name: 'Ana', is_mine: false }]);
    await expect(scalar(seller2, 'select public.academy_delete_question($1)', [q])).rejects.toThrow(
      /academy.not_found/,
    );

    const open = await rows<{ id: string }>(
      admin,
      'select * from public.admin_academy_questions(true, 10, 0)',
    );
    expect(open.map((o) => o.id)).toEqual([q]);
    await scalar(admin, "select public.admin_answer_question($1, 'Veja o módulo 2.')", [q]);
    expect(await rows(admin, 'select * from public.admin_academy_questions(true, 10, 0)')).toEqual(
      [],
    );
    const [answered] = await rows<{ answer: string }>(
      seller,
      'select * from public.academy_lesson_questions($1)',
      [l1],
    );
    expect(answered!.answer).toBe('Veja o módulo 2.');
    await scalar(seller, 'select public.academy_delete_question($1)', [q]);
    await expect(scalar(seller, "select public.academy_ask($1, 'x')", [l1])).rejects.toThrow(
      /academy.invalid/,
    );
  });
});

describe('academia: arquivos', () => {
  it('material só com a aula liberada; capa com o curso visível', async () => {
    const pdf = `materials/${l2}/roteiro.pdf`;
    const cover = `covers/${course}/capa.webp`;
    await insert(
      "insert into public.academy_materials (lesson_id, kind, title, storage_path) values ($1, 'file', 'Roteiro', $2) returning id",
      [l2, pdf],
    );
    await scalar(admin, 'update public.academy_courses set cover_path = $2 where id = $1', [
      course,
      cover,
    ]);
    await db.query(
      "insert into storage.objects (bucket_id, name) values ('academy', $1), ('academy', $2)",
      [pdf, cover],
    );
    const sees = async (name: string, user = seller) =>
      (await rows(user, 'select name from storage.objects where name = $1', [name])).length;

    expect(await sees(cover)).toBe(1);
    expect(await sees(pdf)).toBe(0);
    await complete(l1);
    expect(await sees(pdf)).toBe(1);
    expect(await sees(pdf, seller2)).toBe(0);

    await expect(
      rows(
        seller,
        "insert into storage.objects (bucket_id, name) values ('academy', 'covers/x/y.png')",
      ),
    ).rejects.toThrow(/row-level security/);
    // Caminho do material precisa ser da própria aula.
    await expect(
      insert(
        "insert into public.academy_materials (lesson_id, kind, title, storage_path) values ($1, 'file', 'Errado', $2) returning id",
        [l1, pdf],
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
