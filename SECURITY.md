# Segurança

Documento vivo — cada fase acrescenta os controles que implementa. Status atual reflete apenas o que existe no código.

## Implementado (Fase 1)

- Segredos fora do frontend: somente variáveis `VITE_*` entram no bundle (`envPrefix`), e o ESLint bloqueia acesso a outras variáveis em `src/`.
- `.env*` ignorados pelo Git; `.env.example` sem valores.
- Validação do ambiente público com Zod.
- Cliente Supabase com fluxo **PKCE**.
- Source maps desativados no build de produção.
- TanStack Query não re-tenta erros 4xx (evita martelar endpoints com erro de autorização).

## Planejado (por fase)

| Controle                                                                    | Fase  |
| --------------------------------------------------------------------------- | ----- |
| Auth, sessão, RBAC, throttling de login                                     | 2     |
| RLS deny-by-default, isolamento por tenant, testes de RLS                   | 3     |
| Criptografia de credenciais de marketplace, OAuth seguro                    | 11–16 |
| Verificação de assinatura/HMAC, replay protection, idempotência de webhooks | 17    |
| Ledger imutável, transações atômicas                                        | 19    |
| CSP, CORS restritivo, rate limiting, audit/security logs                    | 22    |

## Pagamentos

Se a plataforma custodiar ou liquidar dinheiro de usuários, isso será feito **exclusivamente** por um provedor de pagamentos/conta de pagamento regulado, com validação jurídica/regulatória no Brasil (BACEN). O banco da TheSigns registra o ledger, não atua como instituição financeira.

## Reportar vulnerabilidades

Não abra issue pública. Contate a equipe TheSigns diretamente.
