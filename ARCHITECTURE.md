# Arquitetura

## Princípios

1. **Segurança > Correção > Integridade de dados > Confiabilidade > Performance > UX.**
2. **Multi-tenant desde o início.** Isolamento por `organization_id` garantido no PostgreSQL (RLS), não no frontend.
3. **Produto interno é a entidade principal.** `Produto TheSigns → Channel Listing → Marketplace`.
4. **Integrações isoladas.** Cada marketplace é um adapter independente com `capabilities` declaradas; a falha de um nunca derruba o core.
5. **Nada pesado em requisição HTTP.** Sync e webhooks são persistidos e processados por jobs (retry, backoff, dead letter, idempotência).
6. **Dinheiro = ledger imutável** com transações atômicas; custódia real apenas via provedor de pagamentos regulado.
7. **Sem funcionalidade fictícia.** Não configurado → "Não configurado". Não suportado pela API → "Não suportado pela API atual".

## Estrutura

```
src/
  app/            # bootstrap: App, providers, router
  components/     # componentes reutilizáveis (ui, theme, brand)
  layouts/        # AppShell (sidebar, topbar, main)
  pages/          # páginas transversais (status, 404)
  features/       # módulos de domínio: auth, seller, supplier, admin, products,
                  # orders, inventory, finance, ai, analytics, integrations
  integrations/   # tipos/cliente das integrações (core + um por marketplace)
  services/ hooks/ lib/ types/ utils/
  styles/         # Tailwind + design tokens (light/dark)

supabase/
  migrations/     # schema versionado (Fase 3)
  functions/      # Edge Functions (Deno): integrations/*, webhooks, orders,
                  # inventory, ai, finance, _shared
  seed/           # dados de desenvolvimento
```

## Fronteira frontend ↔ backend

- O browser recebe **somente** `VITE_SUPABASE_URL` e a **anon key**. A anon key é pública por design; a proteção vem da RLS.
- Segredos (service role, OAuth secrets, OpenAI, chaves de pagamento, chave de criptografia de credenciais) existem **apenas** como Supabase Secrets nas Edge Functions.
- Uma regra ESLint (`no-restricted-syntax`) bloqueia a leitura de qualquer `import.meta.env` que não seja `VITE_*` no frontend.

## Ordem de fases

Ver seção 55 da especificação. Cada fase só é encerrada após `npm run check` verde e revisão de RLS/autorização/segurança/UX, registrada no [CHANGELOG.md](CHANGELOG.md).
