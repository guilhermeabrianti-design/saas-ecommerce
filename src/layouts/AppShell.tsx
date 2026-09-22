import { NavLink, Outlet } from 'react-router';
import { Activity } from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { EnvBadge } from '@/components/ui/EnvBadge';
import { cn } from '@/utils/cn';

const navItems = [{ to: '/', label: 'Status do sistema', icon: Activity }];

export function AppShell() {
  return (
    <div className="flex h-full">
      <aside className="border-border bg-surface hidden w-64 shrink-0 flex-col border-r md:flex">
        <div className="border-border flex h-16 items-center border-b px-5">
          <Logo />
        </div>
        <nav className="flex-1 space-y-1 p-3" aria-label="Principal">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-brand/10 text-brand'
                    : 'text-muted hover:bg-surface-2 hover:text-fg',
                )
              }
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-border bg-surface flex h-16 items-center justify-between gap-4 border-b px-4 md:px-6">
          <div className="md:hidden">
            <Logo />
          </div>
          <div className="ml-auto flex items-center gap-3">
            <EnvBadge />
            <ThemeToggle />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
