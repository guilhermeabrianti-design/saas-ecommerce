import { render, screen } from '@testing-library/react';
import {
  academyErrorMessage,
  flattenLessons,
  formatClock,
  formatDuration,
  lessonActions,
  outlineSchema,
  parseClock,
  parseYouTubeId,
} from './academy';
import { storageFileName, validateAcademyFile } from './api';
import { ProgressBar } from '@/components/ui/ProgressBar';

describe('vídeo do YouTube', () => {
  it('extrai o id dos formatos de link comuns', () => {
    const id = 'dQw4w9WgXcQ';
    for (const link of [
      id,
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtube.com/watch?v=${id}&t=42s`,
      `https://m.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}?si=abc`,
      `youtu.be/${id}`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}`,
      `https://www.youtube.com/live/${id}`,
      `https://www.youtube-nocookie.com/embed/${id}`,
    ]) {
      expect(parseYouTubeId(link)).toBe(id);
    }
  });

  it('recusa o que não é vídeo do YouTube', () => {
    for (const bad of [
      '',
      'abc',
      'https://vimeo.com/123456789',
      'https://www.youtube.com/watch?v=curto',
      'https://evil.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/channel/UC1234567890',
    ]) {
      expect(parseYouTubeId(bad)).toBeNull();
    }
  });
});

describe('tempo', () => {
  it('lê a duração digitada', () => {
    expect(parseClock('12:30')).toBe(750);
    expect(parseClock('1:02:03')).toBe(3723);
    expect(parseClock('90')).toBe(90);
    expect(parseClock('600')).toBe(600);
    expect(parseClock('10:75')).toBeNull();
    expect(parseClock('abc')).toBeNull();
    expect(parseClock('25:00:00')).toBeNull();
  });

  it('formata duração e relógio', () => {
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(750)).toBe('12min');
    expect(formatDuration(3900)).toBe('1h 05min');
    expect(formatClock(378)).toBe('6:18');
    expect(formatClock(3723)).toBe('1:02:03');
    expect(parseClock(formatClock(3723))).toBe(3723);
  });
});

describe('botões de ação e arquivos', () => {
  it('toda ação sugerida passa na validação do banco', () => {
    for (const a of lessonActions) expect(a.path).toMatch(/^\/[a-z0-9/_-]{0,80}$/);
  });

  it('nome de arquivo seguro para o bucket', () => {
    const name = storageFileName(new File(['x'], 'Roteiro de Live — Versão 2.PDF'));
    expect(name).toMatch(/^[0-9a-f]{8}-Roteiro-de-Live-Versao-2\.pdf$/);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(storageFileName(new File(['x'], '../../etc'))).not.toContain('/');
  });

  it('valida tipo e tamanho', () => {
    const pdf = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    expect(validateAcademyFile(pdf, 'material')).toBeNull();
    expect(validateAcademyFile(pdf, 'cover')).toMatch(/JPG/);
    const exe = new File(['x'], 'a.exe', { type: 'application/x-msdownload' });
    expect(validateAcademyFile(exe, 'material')).toMatch(/PDF/);
    const big = new File([new Uint8Array(21 * 1024 * 1024)], 'b.png', { type: 'image/png' });
    expect(validateAcademyFile(big, 'cover')).toMatch(/20 MB/);
  });
});

describe('estrutura do curso', () => {
  it('achata as aulas na ordem dos módulos', () => {
    const lesson = (id: string) => ({
      id,
      title: 'Aula',
      duration_seconds: 60,
      is_required: true,
      unlock_rule: 'none',
      unlocked: true,
      unlock_requested: false,
      completed: false,
      percent: 0,
    });
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const outline = outlineSchema.parse({
      id: uuid(1),
      title: 'Curso',
      description: '',
      level: 'beginner',
      cover_path: null,
      certificate_enabled: false,
      summary: {
        lessons_total: 3,
        lessons_done: 0,
        modules_total: 2,
        modules_done: 0,
        percent: 0,
        completed: false,
      },
      resume_lesson_id: null,
      certificate_id: null,
      modules: [
        {
          id: uuid(2),
          title: 'M1',
          description: '',
          lessons: [lesson(uuid(10)), lesson(uuid(11))],
        },
        { id: uuid(3), title: 'M2', description: '', lessons: [lesson(uuid(12))] },
      ],
    });
    expect(flattenLessons(outline).map((l) => l.id)).toEqual([uuid(10), uuid(11), uuid(12)]);
  });

  it('traduz os erros da Academia', () => {
    for (const code of [
      'academy.not_found',
      'academy.locked',
      'academy.invalid',
      'academy.certificate_disabled',
      'academy.not_completed',
      'academy.limit_reached',
    ]) {
      expect(academyErrorMessage({ message: code })).not.toContain('academy.');
    }
  });

  it('barra de progresso limita entre 0 e 100 e marca a conclusão', () => {
    const { rerender } = render(<ProgressBar percent={130} label="Curso" />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    rerender(<ProgressBar percent={-5} label="Curso" />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
  });
});
