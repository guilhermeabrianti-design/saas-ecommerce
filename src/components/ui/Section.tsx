import type { ReactNode } from 'react';

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="border-border bg-surface rounded-xl border">
      <div className="border-border border-b px-5 py-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-muted text-sm">{description}</p>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}
