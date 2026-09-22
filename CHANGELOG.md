# Changelog

## [0.1.0] — Fase 1: Setup

### Adicionado

- Projeto React + TypeScript (strict) + Vite + Tailwind CSS v4.
- React Router, TanStack Query, Zod, React Hook Form, supabase-js.
- ESLint (flat config, typescript-eslint, react-hooks) + Prettier (com plugin Tailwind).
- Vitest + Testing Library + jsdom.
- Estrutura modular de pastas (`src/features`, `src/integrations`, `supabase/functions`, …).
- Validação do ambiente público (`src/lib/env.ts`) e cliente Supabase opcional (PKCE).
- Design tokens light/dark e alternância de tema.
- AppShell (sidebar, topbar, conteúdo) e página **Status do sistema**.
- Configuração do Supabase local (`supabase/config.toml`).
- `.env.example`, README, ARCHITECTURE, ENVIRONMENT, SECURITY.

### Corrigido (fechamento da fase)

- `devDependencies` ausentes no `package.json` (TypeScript, Vite, ESLint, Prettier, Vitest, Supabase CLI…) — instaladas.
- `supabase/config.toml` gerado e ajustado: `site_url` na porta 5173, seeds em `supabase/seed/*.sql`,
  confirmação de e-mail obrigatória, senha mínima de 10 caracteres (maiúsculas, minúsculas e dígitos),
  reautenticação para troca de senha.
- `npm run check` verde (typecheck, lint, format, 6 testes, build).
