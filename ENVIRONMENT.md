# Ambientes e variáveis

## Ambientes

| Ambiente      | Uso                    | Supabase               | Credenciais de marketplace |
| ------------- | ---------------------- | ---------------------- | -------------------------- |
| `development` | máquina local          | local (CLI/Docker)     | sandbox/teste ou mocks     |
| `staging`     | validação pré-produção | projeto cloud separado | sandbox/teste              |
| `production`  | clientes reais         | projeto cloud dedicado | produção                   |

**Nunca** reutilize credenciais entre ambientes. Credencial de produção nunca entra em development/staging.

## Onde cada variável vive

| Variável                                                              | Onde                     | Pública?                |
| --------------------------------------------------------------------- | ------------------------ | ----------------------- |
| `VITE_APP_ENV`                                                        | `.env.local` / build env | sim                     |
| `VITE_SUPABASE_URL`                                                   | `.env.local` / build env | sim                     |
| `VITE_SUPABASE_ANON_KEY`                                              | `.env.local` / build env | sim (protegida por RLS) |
| `SUPABASE_SERVICE_ROLE_KEY`                                           | Supabase Secrets         | **não**                 |
| `CREDENTIALS_ENCRYPTION_KEY`                                          | Supabase Secrets         | **não**                 |
| `OPENAI_API_KEY`                                                      | Supabase Secrets         | **não**                 |
| `ANTHROPIC_API_KEY` (Fase 13), `AI_MODEL` (opcional)                  | Supabase Secrets         | **não**                 |
| `STOCK_SYNC_SECRET` (Fase 14)                                         | Supabase Secrets + cron  | **não**                 |
| `MERCADOLIVRE_*`, `SHOPEE_*`, `TIKTOK_*`                              | Supabase Secrets         | **não**                 |
| `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY`, `SHOPEE_ENV` (Fase 38)     | Supabase Secrets         | **não**                 |
| `BLING_CLIENT_ID`, `BLING_CLIENT_SECRET` (Fase 36)                    | Supabase Secrets         | **não**                 |
| `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET` (Fase 21)    | Supabase Secrets         | **não**                 |
| `MERCADOPAGO_PUBLIC_KEY` (Fase 21; entregue ao navegador pela função) | Supabase Secrets         | sim (chave pública)     |
| `APP_URL` (Fases 31 e 42: volta do OAuth e da assinatura)             | Supabase Secrets         | **não**                 |

Definir segredos das Edge Functions:

```bash
supabase secrets set --env-file ./supabase/functions/.env   # arquivo local, ignorado pelo Git
```

## Validação

`src/lib/env.ts` valida as variáveis públicas com Zod na inicialização:

- URL inválida ou ambiente desconhecido → erro na inicialização.
- `production` sem Supabase configurado → erro.
- `development` sem Supabase → app roda em modo "Não configurado".

## Arquivos

- `.env.example` — template versionado, **sem valores reais**.
- `.env`, `.env.local`, `.env.*` — ignorados pelo Git.
