import { Outlet } from 'react-router';
import { Logo } from '@/components/brand/Logo';
import { ThemeToggle } from '@/components/theme/ThemeToggle';

/** Páginas de quem compra (sem conta): sem menu do sistema. */
export function PublicLayout() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-border flex h-16 items-center justify-between border-b px-4 md:px-6">
        <Logo />
        <ThemeToggle />
      </header>
      <main className="flex-1 px-4 pt-6 pb-16 md:pt-10">
        <div className="mx-auto w-full max-w-4xl">
          <Outlet />
        </div>
      </main>
      <footer className="text-muted pb-6 text-center text-xs">
        Pagamento processado pelo Mercado Pago.
      </footer>
    </div>
  );
}
