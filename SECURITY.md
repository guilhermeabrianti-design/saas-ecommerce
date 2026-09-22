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
| RLS deny-by-default, isolamento por tenant, testes de RLS                   | 3     |
| Criptografia de credenciais de marketplace, OAuth seguro                    | 11–16 |
| Verificação de assinatura/HMAC, replay protection, idempotência de webhooks | 17    |
| Ledger imutável, transações atômicas                                        | 19    |
| CSP, CORS restritivo, rate limiting, audit/security logs                    | 22    |

## Pagamentos

Se a plataforma custodiar ou liquidar dinheiro de usuários, isso será feito **exclusivamente** por um provedor de pagamentos/conta de pagamento regulado, com validação jurídica/regulatória no Brasil (BACEN). O banco da TheSigns registra o ledger, não atua como instituição financeira.

## Reportar vulnerabilidades

Não abra issue pública. Contate a equipe TheSigns diretamente.
