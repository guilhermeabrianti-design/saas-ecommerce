import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme, type Theme } from './theme-context';

const order: Theme[] = ['light', 'dark', 'system'];
const labels: Record<Theme, string> = { light: 'Claro', dark: 'Escuro', system: 'Sistema' };
const icons = { light: Sun, dark: Moon, system: Monitor } as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = order[(order.indexOf(theme) + 1) % order.length] ?? 'system';
  const Icon = icons[theme];

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      className="border-border text-muted hover:bg-surface-2 hover:text-fg inline-flex size-9 items-center justify-center rounded-lg border transition-colors"
      aria-label={`Tema: ${labels[theme]}. Alternar para ${labels[next]}`}
      title={`Tema: ${labels[theme]}`}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}
