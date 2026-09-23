# TheSigns — E-commerce & Dropshipping OS

SaaS multi-tenant para vendedores de e-commerce/dropshipping, fornecedores e equipe TheSigns.

> **Status:** Fase 13 (IA — descrição de produto) concluída. Veja [CHANGELOG.md](CHANGELOG.md) para o progresso por fase.

## Stack

| Camada    | Tecnologia                                                                 |
| --------- | -------------------------------------------------------------------------- |
| Frontend  | React 19, TypeScript (strict), Vite, Tailwind CSS v4, React Router         |
| Estado    | TanStack Query (server state), React Hook Form + Zod (formulários)         |
| Backend   | Supabase: PostgreSQL + RLS, Auth, Storage, Edge Functions (Deno), Realtime |
| Qualidade | ESLint (flat config), Prettier, Vitest + Testing Library                   |

## Requisitos

- Node.js ≥ 20.19 (LTS recomendado)
- Git
- Docker Desktop (apenas para rodar o Supabase local)

## Primeiros passos

```bash
npm install
cp .env.example .env.local   # preencha apenas as variáveis VITE_*
npm run dev                  # http://localhost:3001
```

Sem Supabase configurado, o app roda e mostra **"Não configurado"** na página de status.

### Supabase local (opcional nesta fase)

```bash
npm run supabase:start       # requer Docker; imprime URL e anon key locais
```

Copie a `API URL` e a `anon key` exibidas para `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` em `.env.local`.

## Scripts

| Script                            | O que faz                                               |
| --------------------------------- | ------------------------------------------------------- |
| `npm run dev`                     | Servidor de desenvolvimento                             |
| `npm run build`                   | Typecheck + build de produção                           |
| `npm run lint` / `lint:fix`       | ESLint                                                  |
| `npm run format` / `format:check` | Prettier                                                |
| `npm test`                        | Testes (Vitest)                                         |
| `npm run check`                   | Gate completo da fase: types, lint, format, test, build |
| `npm run supabase:start` / `stop` | Supabase local                                          |
| `npm run supabase:types`          | Gera tipos TS a partir do schema local                  |

## Documentação

- [ARCHITECTURE.md](ARCHITECTURE.md) — estrutura e princípios
- [ENVIRONMENT.md](ENVIRONMENT.md) — variáveis e ambientes
- [SECURITY.md](SECURITY.md) — modelo de segurança
- [DATABASE.md](DATABASE.md) — schema, RLS e testes de banco
- [CHANGELOG.md](CHANGELOG.md) — progresso por fase

Os demais documentos (INTEGRATIONS, API, DEPLOYMENT, TESTING, TROUBLESHOOTING) são criados nas fases em que seu conteúdo passa a existir.
