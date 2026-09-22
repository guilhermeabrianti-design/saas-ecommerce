# Banco de dados

PostgreSQL gerenciado pelo Supabase. O schema é versionado em `supabase/migrations/` e é a fonte da
verdade: nada é criado manualmente pelo painel.

## Regras

- **RLS em toda tabela do schema `public`**, sem exceção.
- O Supabase concede `ALL` para `anon`/`authenticated` em tabelas novas; cada migração **revoga tudo**
  e concede só o necessário (inclusive por coluna, quando aplicável).
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
