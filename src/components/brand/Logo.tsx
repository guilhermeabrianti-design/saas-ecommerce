export function Logo() {
  return (
    <span className="flex items-center gap-2 text-base font-semibold tracking-tight">
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-fg" />
        <path
          d="M9 10h14M16 10v13"
          className="stroke-canvas"
          strokeWidth="3.2"
          strokeLinecap="round"
        />
        <circle cx="23" cy="22" r="2.4" className="fill-accent" />
      </svg>
      <span>
        The<span className="text-brand">Signs</span>
      </span>
    </span>
  );
}
