import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <p className="text-brand font-mono text-sm">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Página não encontrada</h1>
      <Link to="/" className="text-brand mt-6 inline-block text-sm font-medium hover:underline">
        Voltar ao início
      </Link>
    </div>
  );
}
