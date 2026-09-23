# Segurança

Documento vivo — cada fase acrescenta os controles que implementa. Status atual reflete apenas o que existe no código.

## Implementado (Fase 1)

- Segredos fora do frontend: somente variáveis `VITE_*` entram no bundle (`envPrefix`), e o ESLint bloqueia acesso a outras variáveis em `src/`.
- `.env*` ignorados pelo Git; `.env.example` sem valores.
- Validação do ambiente público com Zod.
- Cliente Supabase com fluxo **PKCE**.
- Source maps desativados no build de produção.
- TanStack Query não re-tenta erros 4xx (evita martelar endpoints com erro de autorização).

## Implementado (Fase 2)

- **Autenticação** via Supabase Auth (e-mail + senha, PKCE). Confirmação de e-mail obrigatória.
- **Política de senha**: mínimo 10 caracteres com minúscula, maiúscula e número (validada no cliente
  e imposta pelo servidor em `supabase/config.toml`).
- **Troca de senha** exige reautenticação por código enviado por e-mail quando a sessão tem mais de
  24h (`secure_password_change`).
- **Sem enumeração de contas**: login, cadastro e recuperação de senha respondem igual exista ou não
  a conta.
- **Throttling de login**: rate limit por IP no Supabase Auth (15 tentativas/5min) + backoff no
  cliente após 3 falhas. O backoff do cliente é só UX; o controle real é o do servidor.
- **RBAC**: papel em `profiles.role`. Usuário escolhe apenas `seller`/`supplier` no cadastro; `admin`
  só via service role/SQL. O usuário não tem privilégio de `UPDATE` na coluna `role`.
- **RLS em `profiles`**: cada usuário lê/edita só o próprio perfil; `anon` sem acesso; privilégios
  padrão do Supabase revogados. Coberto por testes (`src/test/db/auth-profiles.test.ts`).
- **Sessão**: cache de dados do usuário anterior é descartado ao sair/trocar de conta; logout local
  funciona mesmo sem rede.
- **Open redirect**: `?next=` aceita apenas caminhos internos (`safeNextPath`).
- Mensagens de erro do servidor nunca são exibidas cruas ao usuário.

## Implementado (Fase 3)

- **Deny-by-default**: privilégios padrão do schema `public` revogados para `anon`/`authenticated`
  (tabelas, sequências e funções). Nada novo fica acessível sem `grant` explícito na migração.
- **Isolamento por tenant**: toda tabela de negócio terá `organization_id` e RLS baseada em
  `private.is_org_member` / `private.has_org_role`. O frontend nunca decide o tenant: um id de
  organização forjado no `localStorage` só resulta em consultas vazias.
- **Escritas sensíveis por RPC**: membros e convites não têm `INSERT/UPDATE/DELETE` direto; as RPCs
  `security definer` validam papel, tipo de conta e a regra de "ao menos um owner" dentro de uma
  transação com lock na organização.
- **Convites**: aceitos apenas pelo dono do e-mail **confirmado** (`email_confirmed_at`), expiram em
  7 dias; convite inexistente, expirado ou de outra pessoa retorna o mesmo erro. Limites: 10
  organizações criadas por usuário, 100 convites ativos por organização.
- **Invariantes testadas a cada `npm test`** (`src/test/db/rls-baseline.test.ts`): RLS em todas as
  tabelas de `public`, `anon` sem privilégios, lista fechada de RPCs executáveis por
  `authenticated`, `search_path` vazio em toda função `security definer`.
- Contas `admin` (equipe TheSigns) não pertencem a organizações de clientes e não têm acesso a dados
  de tenants pela API. Acesso de suporte será desenhado (com auditoria) na fase de administração.

### Limitações conhecidas (Fase 3)

- Convite não envia e-mail (a UI informa isso); o convidado vê o convite ao entrar.
- Excluir um usuário no painel do Supabase remove suas participações; se ele for o único owner, a
  organização fica sem owner e precisa ser corrigida via SQL.

## Implementado (Fase 4)

- `products` segue o padrão de tenant: leitura por membros, escrita por owner/admin, `organization_id`
  imutável e `created_by` definido pelo banco. Exclusão só de rascunhos.
- Busca textual é saneada antes de virar filtro PostgREST (`sanitizeSearch`).
- Dinheiro sempre em centavos inteiros, no banco e na conversão da UI.

## Implementado (Fase 5)

- Variações e imagens herdam o isolamento do produto por FK composta `(organization_id, product_id)`.
- Bucket `product-images` privado, com policies por organização em `storage.objects`, limite de
  tamanho/tipo no servidor e URLs assinadas de 1h. Sem sobrescrita de arquivos.
- Triggers `security definer` não respondem regras de negócio a quem não tem papel na organização
  (evita oráculo de SKU/contagem entre tenants).

## Implementado (Fase 6)

- Estoque com livro-razão imutável (nem service role altera ou apaga movimentações).
- Movimentações só por RPC, com papel checado antes do lock, saldo nunca negativo e idempotência
  por `request_id` (proteção contra clique duplo e retry de rede).
- View de saldos com `security_invoker` (sem bypass de RLS).

## Implementado (Fase 7)

- Primeiro compartilhamento entre tenants (catálogo de fornecedores) feito **somente por RPCs** com
  lista explícita de colunas; vendedores nunca leem linhas de `products` do fornecedor.
- Catálogo visível apenas para membros de organizações vendedoras; fornecedores não veem
  concorrentes.
- Vínculo de origem de produtos importados não é gravável pelo cliente.

### Configuração obrigatória no projeto Supabase cloud

`supabase/config.toml` vale só para o ambiente local. Em staging/produção, replique no painel
(Authentication → Providers/Policies/Rate limits/URL configuration):

- Confirm email: **on** · Secure password change: **on**
- Minimum password length: **10** · Password requirements: **lowercase, uppercase, digits**
- Rate limit de sign-in/sign-up: **15 / 5 min por IP**
- Site URL e Redirect URLs: domínio do ambiente (`/entrar`, `/redefinir-senha`)
- SMTP próprio (o SMTP padrão do Supabase tem limite baixo e não é para produção)
- Recomendado antes de abrir cadastro público: CAPTCHA (Turnstile/hCaptcha) — ainda não integrado.

## Planejado (por fase)

| Controle                                                                    | Fase  |
| --------------------------------------------------------------------------- | ----- |
| Criptografia de credenciais de marketplace, OAuth seguro                    | 11–16 |
| Verificação de assinatura/HMAC, replay protection, idempotência de webhooks | 17    |
| Ledger imutável, transações atômicas                                        | 19    |
| CSP, CORS restritivo, rate limiting, audit/security logs                    | 22    |

## Pagamentos

Se a plataforma custodiar ou liquidar dinheiro de usuários, isso será feito **exclusivamente** por um provedor de pagamentos/conta de pagamento regulado, com validação jurídica/regulatória no Brasil (BACEN). O banco da TheSigns registra o ledger, não atua como instituição financeira.

## Reportar vulnerabilidades

Não abra issue pública. Contate a equipe TheSigns diretamente.
