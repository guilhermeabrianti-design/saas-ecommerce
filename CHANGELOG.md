# Changelog

## [0.5.0] — Fase 5: Variações e imagens de produto

### Adicionado

- **Banco** (`supabase/migrations/20260922150000_product_variants_images.sql`):
  - `product_variants`: unidade vendável com SKU próprio, 1–3 atributos (ex.: Cor/Tamanho, validados
    por `private.valid_variant_attributes`), preço/GTIN/peso opcionais que sobrescrevem os do
    produto, ativa/inativa. Combinação de atributos única por produto.
  - **SKU único na organização entre produtos e variações** (trigger com lock transacional por
    organização).
  - `product_images`: ordem das imagens (máx. 10 por produto, posição atribuída pelo banco) e RPC
    `set_product_image_order` (security invoker).
  - FKs compostas `(organization_id, product_id)`: filhos de um produto sempre pertencem à mesma
    organização dele.
  - **Storage**: bucket privado `product-images` (5 MB; JPEG/PNG/WebP) com policies em
    `storage.objects` — caminho obrigatório `{organização}/{produto}/{arquivo}`; membros leem,
    owner/admin enviam e excluem; sem sobrescrita.
- **Telas** (página do produto): seções **Variações** (criar, editar, ativar/desativar, excluir em
  rascunho; sugere os atributos já usados) e **Imagens** (envio múltiplo, capa, reordenar, excluir;
  URLs assinadas de 1h).
- Emulação mínima do Storage no banco de teste (`storage.buckets`, `storage.objects`).
- **Testes**: 17 de banco (variações, imagens, storage) e 14 de lógica de frontend.

### Revisão de segurança (fechamento da fase)

- **Corrigido — oráculo entre tenants**: triggers `BEFORE INSERT` rodam antes do `WITH CHECK` da RLS.
  Os triggers `security definer` de SKU e de limite de imagens respondiam `products.sku_taken` /
  `products.image_limit` a quem tentasse inserir em organização alheia, revelando SKUs e contagem de
  imagens de outro tenant. Agora, para usuário logado sem papel owner/admin na organização, os
  triggers não fazem nada e a RLS recusa normalmente. Service role (sem `auth.uid()`) continua
  sujeita às regras. Coberto por 2 testes de regressão.
- Upload: o arquivo é removido se o registro em `product_images` for recusado (sem órfãos).
- Exclusão de imagem apaga o registro antes do arquivo: o produto nunca aponta para arquivo ausente.
- Verificado: variação/imagem não mudam de produto ou organização; caminho de imagem fora da pasta
  do produto, com `..` ou extensão não permitida é recusado pelo banco; `anon` não lê o bucket.
- `npm run check` verde: typecheck, lint, format, 185 testes, build.

### Limitações conhecidas

- Excluir um produto rascunho remove os registros das imagens, mas os arquivos ficam no bucket
  (privados e inacessíveis pela API, pois a policy exige que o produto exista). Limpeza por job com
  service role em fase futura.
- Tipo/tamanho do arquivo são validados pelo Storage pelo `Content-Type` declarado, sem inspeção do
  conteúdo; o bucket é privado e servido por URL assinada fora da origem do app.

## [0.4.0] — Fase 4: Produtos (catálogo interno)

### Adicionado

- **Banco** (`supabase/migrations/20260922140000_products.sql`): tabela `products` por organização —
  SKU (único por organização, sem diferenciar maiúsculas), nome, descrição, marca, GTIN, preço e
  custo em **centavos** (`bigint`), peso/dimensões para frete e status `draft`/`active`/`archived`.
- **Permissões**: membros leem; owner/admin criam e editam; só rascunhos podem ser excluídos
  (os demais são arquivados). `organization_id`, `created_by` e datas não são graváveis pelo
  cliente depois da criação (grants por coluna).
- **Telas**: **Produtos** (busca por nome/SKU, filtro de status, paginação de 25, estado vazio) e
  formulário de produto (criar/editar, margem bruta calculada, excluir rascunho). Membros veem em
  modo leitura.
- `src/utils/money.ts`: conversão BRL ↔ centavos só com aritmética de strings (sem erro de ponto
  flutuante).
- Validação de GTIN/EAN com dígito verificador GS1 no formulário.
- **Testes**: 11 de RLS/regras de produtos, 21 de dinheiro, 23 de schema/busca/erros de produto.

### Revisão de segurança (fechamento da fase)

- Busca livre entra num filtro `or=(…)` do PostgREST: `sanitizeSearch` remove `,()"\` e curingas
  antes de montar o filtro (coberto por teste). Mesmo um filtro manipulado continuaria limitado pela
  RLS às organizações do usuário.
- `UPDATE`/`DELETE` negados pela RLS retornam 0 linhas sem erro; o frontend trata "0 linhas" como
  falha em vez de exibir sucesso falso.
- Verificado: produto não muda de organização nem tem autoria forjada; membro comum não escreve;
  usuário de outra organização não lê, edita nem exclui; `anon` sem acesso; tabela coberta pelas
  invariantes de `rls-baseline.test.ts`.
- `npm run check` verde: typecheck, lint, format, 157 testes, build.

### Limitações conhecidas

- Sem variações (cor/tamanho) e sem imagens: entram em fase própria.
- Sem limite de produtos por organização (rate limiting é da Fase 22).
- Excluir uma organização apaga seus produtos em cascata; quando houver pedidos, as referências
  usarão `restrict`.

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
