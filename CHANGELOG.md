# Changelog

## [0.3.0] — Fase 3: Organizações (tenants) e RLS deny-by-default

### Adicionado

- **Banco** (`supabase/migrations/20260922130000_organizations.sql`): `organizations`,
  `organization_members` e `organization_invitations`, com papéis `owner`/`admin`/`member` e tipo
  (`seller`/`supplier`) herdado da conta de quem cria.
- **Deny-by-default**: tabelas, sequências e funções novas do schema `public` nascem sem acesso para
  `anon`/`authenticated`; cada migração concede explicitamente o que precisa.
- **Isolamento por tenant**: RLS com helpers `private.is_org_member` / `private.has_org_role`
  (schema `private`, fora da API). Usuário só enxerga organizações das quais é membro.
- **RPCs** com regras explícitas: criar organização, listar membros, convidar/revogar, aceitar/recusar
  convite, alterar papel, remover membro/sair. Organização sempre mantém ao menos um owner (operações
  serializadas por lock na organização).
- **Testes**: 28 testes de isolamento/papéis/convites e 7 invariantes de schema
  (`src/test/db/rls-baseline.test.ts`): RLS em toda tabela, `anon` sem privilégios, objetos novos sem
  acesso, lista fechada de RPCs executáveis, `search_path` fixo em funções `security definer`.
- **Telas**: onboarding "Configure sua organização" (criar ou aceitar convite), **Organização**
  (dados, membros e papéis, convites, sair), convites pendentes na página inicial e seletor de
  organização ativa no topo.
- Componentes `Section`, `Select`, `ConfirmButton`.

### Alterado

- Testes nunca usam o Supabase real, mesmo com `.env.local` preenchido.
- Banco de teste migrado uma vez por arquivo e restaurado de snapshot (suíte de banco ~3× mais
  rápida).
- `Section` extraído de Minha conta para `src/components/ui`.

### Revisão de segurança (fechamento da fase)

- Convites passaram a exigir e-mail **confirmado** no SQL (`email_confirmed_at`), sem depender só
  da opção "Confirm email" do painel — do contrário, um cadastro com o e-mail de outra pessoa
  aceitaria o convite dela. Coberto por teste.
- `public.set_updated_at()` (Fase 2) tinha `EXECUTE` para `PUBLIC` por padrão; revogado.
- Verificado: RPCs recusam organização alheia; ids de convite/organização adivinhados não revelam
  existência (mesmo erro); `kind`/`created_by` e papéis não são alteráveis por `UPDATE` direto;
  corrida entre dois owners se rebaixando é serializada por `select … for update`.
- `npm run check` verde: typecheck, lint, format, 103 testes, build.

## [0.2.0] — Fase 2: Autenticação, sessão e RBAC

### Adicionado

- **Banco** (`supabase/migrations/20260922120000_auth_profiles.sql`): enum `app_role`
  (`seller`, `supplier`, `admin`) e tabela `profiles` 1:1 com `auth.users`, criada por trigger no
  cadastro. RLS habilitada; usuário lê/edita apenas o próprio perfil e só pode alterar `full_name`.
  `admin` nunca é atribuído a partir dos metadados do cliente.
- **Testes de banco sem Docker**: PGlite (Postgres em WASM) com emulação mínima do Supabase
  (`src/test/db/supabase-sim.ts`); 12 testes de RLS/privilégios rodam em `npm test`.
- **Telas**: Entrar, Criar conta (Vendedor/Fornecedor), Recuperar senha, Redefinir senha, Início e
  Minha conta (editar nome, trocar senha com reautenticação por código, sair).
- **Sessão**: `AuthProvider` (PKCE, restauração de sessão, cache do TanStack Query limpo ao sair ou
  trocar de usuário).
- **Rotas**: `RequireAuth` (preserva `?next`), `RedirectIfAuthenticated` (com proteção contra open
  redirect), `RequireRole` (RBAC de UX; a autorização real é a RLS).
- **Throttling de login**: backoff no cliente após 3 falhas (15s → 5min) + rate limit do Supabase
  Auth reduzido para 15 tentativas/5min por IP.
- Componentes de UI: `Button`, `TextField`, `Alert`, `PageLoader`. Navegação móvel no AppShell.
- `/status` continua público (funciona sem Supabase configurado).

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
