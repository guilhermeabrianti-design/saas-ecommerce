# Banco de dados

PostgreSQL gerenciado pelo Supabase. O schema é versionado em `supabase/migrations/` e é a fonte da
verdade: nada é criado manualmente pelo painel.

## Regras

- **RLS em toda tabela do schema `public`**, sem exceção.
- **Deny-by-default** (desde a Fase 3): tabelas, sequências e funções novas de `public` nascem sem
  privilégio para `anon`/`authenticated`. Cada migração concede só o necessário (inclusive por
  coluna) e mesmo assim começa com `revoke all` explícito.
- **Tabelas de negócio** têm `organization_id uuid not null references public.organizations on delete cascade`
  e policies no formato:
  ```sql
  using (private.is_org_member(organization_id))                        -- leitura
  with check (private.has_org_role(organization_id, '{owner,admin}'))   -- escrita restrita
  ```
- Helpers de autorização vivem no schema `private` (não exposto pela API).
- Nova RPC executável por `authenticated` precisa entrar em `AUTHENTICATED_RPCS` em
  `src/test/db/rls-baseline.test.ts` — o teste falha para qualquer função exposta sem intenção.
- Funções `security definer` sempre com `set search_path = ''` e nomes totalmente qualificados.
- Nunca confiar em `raw_user_meta_data` (é controlado pelo cliente) para conceder privilégios.

## Tabelas

### `public.profiles` (Fase 2)

Perfil 1:1 com `auth.users`, criado pelo trigger `on_auth_user_created`.

| Coluna       | Tipo              | Observação                                            |
| ------------ | ----------------- | ----------------------------------------------------- |
| `id`         | `uuid` PK/FK      | `auth.users.id`, `on delete cascade`                  |
| `full_name`  | `text`            | 2–120 caracteres; único campo editável pelo usuário   |
| `role`       | `public.app_role` | `seller` \| `supplier` \| `admin`; `admin` só via SQL |
| `created_at` | `timestamptz`     |                                                       |
| `updated_at` | `timestamptz`     | atualizado por trigger                                |

| Operação | `anon` | `authenticated`                     |
| -------- | ------ | ----------------------------------- |
| SELECT   | —      | só o próprio perfil                 |
| UPDATE   | —      | só o próprio perfil, só `full_name` |
| INSERT   | —      | — (apenas o trigger)                |
| DELETE   | —      | — (cascata ao excluir o usuário)    |

Promover alguém a admin (SQL editor, com service role):

```sql
update public.profiles set role = 'admin' where id = '<uuid do usuário>';
```

### `public.organizations` (Fase 3)

Tenant. `kind` (`seller` | `supplier`) vem do tipo de conta de quem cria e é imutável.

| Operação | `authenticated`                                          |
| -------- | -------------------------------------------------------- |
| SELECT   | membros                                                  |
| UPDATE   | owner/admin, só `name`                                   |
| INSERT   | — (RPC `create_organization`, que torna o criador owner) |
| DELETE   | —                                                        |

### `public.organization_members` (Fase 3)

PK `(organization_id, user_id)`; `role` = `owner` | `admin` | `member`. Leitura por membros da mesma
organização; escrita apenas pelas RPCs `accept_invitation`, `update_member_role`, `remove_member`.

| Ação                 | owner | admin            | member |
| -------------------- | ----- | ---------------- | ------ |
| Renomear organização | ✓     | ✓                | —      |
| Convidar             | ✓     | só como `member` | —      |
| Alterar papéis       | ✓     | —                | —      |
| Remover outra pessoa | ✓     | só `member`      | —      |
| Sair                 | ✓\*   | ✓                | ✓      |

\* O último owner não pode sair, ser removido nem rebaixado.

### `public.organization_invitations` (Fase 3)

Convite por e-mail (minúsculo), único por organização, válido por 7 dias; reenviar renova. Leitura
por owner/admin da organização; o convidado vê os seus via `my_pending_invitations()` e responde com
`accept_invitation` / `decline_invitation` (exige e-mail confirmado e tipo de conta igual ao da
organização).

### `public.products` (Fase 4)

Produto interno TheSigns — fonte da verdade para anúncios em marketplaces.

| Coluna                                               | Tipo                    | Observação                                                          |
| ---------------------------------------------------- | ----------------------- | ------------------------------------------------------------------- |
| `organization_id`                                    | `uuid` FK               | só na criação; cascata ao excluir organização                       |
| `sku`                                                | `text`                  | `[A-Za-z0-9][A-Za-z0-9._-]{0,59}`; único por org (case-insensitive) |
| `name` / `description` / `brand`                     | `text`                  | 2–200 / até 5000 / 1–80                                             |
| `gtin`                                               | `text`                  | 8, 12, 13 ou 14 dígitos (dígito verificador validado na UI)         |
| `price_cents` / `cost_cents`                         | `bigint`                | centavos de BRL, ≥ 0; custo opcional                                |
| `weight_grams`, `length_mm`, `width_mm`, `height_mm` | `integer`               | opcionais, > 0                                                      |
| `status`                                             | `public.product_status` | `draft` \| `active` \| `archived`                                   |
| `created_by`                                         | `uuid`                  | `auth.uid()` do criador; não gravável                               |

| Operação | `authenticated`                                             |
| -------- | ----------------------------------------------------------- |
| SELECT   | membros da organização                                      |
| INSERT   | owner/admin                                                 |
| UPDATE   | owner/admin (exceto `organization_id`, `created_by`, datas) |
| DELETE   | owner/admin, só `status = draft`                            |

### RPCs (Fase 3)

`create_organization`, `list_organization_members`, `invite_member`, `revoke_invitation`,
`my_pending_invitations`, `accept_invitation`, `decline_invitation`, `update_member_role`,
`remove_member`. Erros de regra usam mensagens estáveis `org.*`, traduzidas em
`src/features/organizations/errors.ts`.

## Testes

Os testes de banco rodam em `npm test` **sem Docker**, usando PGlite (Postgres em WASM).
`src/test/db/supabase-sim.ts` cria os papéis `anon`/`authenticated`, os privilégios padrão do
Supabase e um schema `auth` mínimo, e então aplica todas as migrações em ordem. `asUser(db, id, fn)`
executa consultas como um usuário autenticado (ou `anon`), exercitando a RLS de verdade.

Toda nova tabela deve vir com testes de: leitura/escrita do próprio dado, bloqueio de dados de
terceiros, bloqueio de `anon` e de colunas protegidas.

## Supabase local

Com Docker instalado: `npm run supabase:start`, depois `npm run supabase:reset` para aplicar as
migrações e `npm run supabase:types` para gerar os tipos TypeScript.
