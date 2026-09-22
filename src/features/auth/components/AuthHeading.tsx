import type { ReactNode } from 'react';

export function AuthHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {children && <p className="text-muted mt-1 text-sm">{children}</p>}
    </div>
  );
}
