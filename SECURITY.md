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

## Implementado (Fase 8)

- Pedidos e pedidos de fornecimento só alteráveis por RPC; reservas e baixas de estoque atômicas,
  idempotentes e sem deadlock (ordem fixa de travas).
- Compartilhamento com o fornecedor limitado aos dados de entrega (minimização — LGPD).
- Teste de invariante: funções internas do schema `private` não são executáveis pelo cliente.

## Implementado (Fase 9)

- Livro-razão financeiro **imutável** (trigger bloqueia update/delete/truncate, inclusive para o
  service role); valor com sinal validado por tipo de lançamento.
- Dados financeiros só para owner/admin; escrita somente por RPC (sem grants de escrita); saldos
  do pedido protegidos por constraint (líquido recebido ≤ total).
- Acerto com fornecedor atômico (débito + crédito na mesma transação) e não repetível.

## Implementado (Fase 10)

- **Segredo do webhook** em tabela sem nenhum privilégio para `anon`/`authenticated` (só o service
  role lê); nunca devolvido por RPC ou consulta. Desconectar apaga o segredo.
- **Assinatura HMAC-SHA256** verificada em tempo constante sobre o corpo bruto antes de qualquer
  processamento; conexão inexistente, de outro provedor ou desconectada responde igual (sem oráculo).
- **Idempotência**: mesmo pedido externo nunca cria dois pedidos (lock por pedido + request_id
  determinístico + unicidade). Retransmissão do mesmo webhook é inofensiva (replay não duplica).
- Payload de pedido com erro (dados do cliente) fica só no banco: a API expõe apenas o indicador
  `retryable` (grant por coluna). Entra na política de retenção/LGPD do vendedor.
- Ingestão e worker de estoque executáveis só pelo service role (invariante em
  `rls-baseline.test.ts`).
- Limite: o segredo do webhook está em texto no banco (só verificação de assinatura). Tokens OAuth
  dos demais marketplaces exigirão criptografia com `CREDENTIALS_ENCRYPTION_KEY` antes de existirem.
- A Edge Function `webhooks` **não foi executada** neste ambiente (sem Deno/Supabase CLI): a
  normalização e a assinatura são testadas; o roteamento deve ser exercitado com
  `supabase functions serve` antes de produção.

## Implementado (Fase 12)

- Papel `admin` da equipe só via SQL; RPCs administrativas checam o papel no servidor. A equipe
  enxerga **agregados**, nunca dados de negócio (teste de isolamento).
- Suspensão com motivo obrigatório e trilha de auditoria imutável (sem grants, sem UPDATE/DELETE).
- Suspensão aplicada no helper central de autorização: uma organização suspensa não lê nem escreve
  nada (nem via RPC de outro tenant que dependa dela: catálogo, roteirização, webhooks).
- Pendente: MFA obrigatório para contas da equipe; alerta por e-mail em ações administrativas.

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
