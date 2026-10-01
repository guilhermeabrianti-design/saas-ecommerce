import { Link, Outlet } from 'react-router';
import { Logo } from '@/components/brand/Logo';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { EnvBadge } from '@/components/ui/EnvBadge';

export function AuthLayout() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex h-16 items-center justify-between px-4 md:px-6">
        <Link to="/" aria-label="TheSigns — início">
          <Logo />
        </Link>
        <div className="flex items-center gap-3">
          <EnvBadge />
          <ThemeToggle />
        </div>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-6 pb-16 md:pt-16">
        <div className="border-border bg-surface w-full max-w-md rounded-2xl border p-6 shadow-sm md:p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
