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
| `full_name`  | `text`            | 2–120 caracteres; editável pelo usuário               |
| `role`       | `public.app_role` | `seller` \| `supplier` \| `admin`; `admin` só via SQL |
| `phone`      | `text`            | Fase 18: só dígitos, DDD + fixo/celular; editável     |
| `document`   | `text`            | Fase 18: CPF/CNPJ com dígitos verificadores; editável |
| `created_at` | `timestamptz`     |                                                       |
| `updated_at` | `timestamptz`     | atualizado por trigger                                |

| Operação | `anon` | `authenticated`                                        |
| -------- | ------ | ------------------------------------------------------ |
| SELECT   | —      | só o próprio perfil                                    |
| UPDATE   | —      | só o próprio perfil, só `full_name`/`phone`/`document` |
| INSERT   | —      | — (apenas o trigger)                                   |
| DELETE   | —      | — (cascata ao excluir o usuário)                       |

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

### `public.product_variants` (Fase 5)

Unidade vendável de um produto. FK composta `(organization_id, product_id)` → `products`.
`attributes` é um objeto JSON com 1–3 pares texto→texto (ex.: `{"Cor": "Azul", "Tamanho": "M"}`),
único por produto. `price_cents`, `gtin` e `weight_grams` nulos herdam do produto. Mesmas permissões
de `products`; excluir só enquanto o produto é rascunho (senão, `is_active = false`).

**SKU**: único por organização **entre `products` e `product_variants`** (trigger
`private.enforce_org_sku_unique`, erro `products.sku_taken`).

### `public.product_images` (Fase 5)

Ordem das imagens de um produto (máx. 10). `storage_path` = `{organization_id}/{product_id}/{arquivo}.{jpg|png|webp}`,
validado por constraint. `position` é definida pelo banco no insert e alterada só pela RPC
`set_product_image_order(p_product, p_image_ids[])`.

### Storage: bucket `product-images` (Fase 5)

Privado, 5 MB, JPEG/PNG/WebP. Policies em `storage.objects` exigem que o caminho aponte para um
produto existente da organização (`private.product_image_path_org`): membros leem (URLs assinadas),
owner/admin enviam e excluem. Não há policy de `UPDATE` (sem sobrescrita).

> Triggers `BEFORE` rodam **antes** do `WITH CHECK` da RLS. Trigger `security definer` que lança
> erro de regra de negócio deve primeiro verificar se quem chama tem papel na organização; senão
> vira oráculo entre tenants (ver CHANGELOG 0.5.0).

### `public.inventory_items` (Fase 6)

Saldo por unidade vendável, criado por trigger ao inserir produto/variação. FKs compostas para
`products` e `product_variants`. `reserved ≤ on_hand`, ambos ≥ 0. Cliente só altera `min_quantity`
(owner/admin); saldos mudam apenas via `adjust_stock` / `set_stock`.

### `public.inventory_movements` (Fase 6)

Livro-razão **imutável** (trigger bloqueia `UPDATE`/`DELETE`/`TRUNCATE` para todos). Cada linha:
`quantity_delta` (≠ 0), `on_hand_after`, `reason` (`purchase` | `return` | `adjustment` | `loss` |
`count`), `note`, `created_by` (sem FK, sobrevive ao usuário) e `request_id` (único por organização,
garante idempotência). Consequência: produto/variação com movimentações não pode ser excluído.

### `public.inventory_levels` (view, Fase 6)

`security_invoker`: aplica a RLS de quem consulta. Une saldo + produto + variação, calcula
`available` e `is_low` e esconde o saldo de nível produto quando o produto tem variações.

### RPCs de estoque (Fase 6)

- `adjust_stock(p_item, p_delta, p_reason, p_note, p_request_id)`: compra/devolução > 0, perda < 0,
  ajuste ≠ 0.
- `set_stock(p_item, p_quantity, p_note, p_request_id)`: contagem; registra a diferença como `count`.

Ambas: owner/admin, linha travada, sem saldo negativo, idempotentes. Erros `inventory.*`.

### `public.catalog_listings` (Fase 7)

Anúncio do fornecedor no catálogo: `wholesale_price_cents`, `suggested_price_cents`,
`is_published`. FK composta para `products`; único por `(organization_id, product_id)`. Só
owner/admin de organização `supplier` escrevem; só membros do próprio fornecedor leem a tabela.

**Acesso cruzado** (vendedores) exclusivamente por RPCs `security definer` com colunas escolhidas:

- `search_catalog(p_query, p_limit, p_offset)` — anúncios publicados de produtos ativos.
- `get_catalog_listing(p_listing)` — detalhe (JSON) com variações ativas e caminhos de imagem.
- `import_catalog_listing(p_org, p_listing, p_sku_prefix)` — cria produto rascunho + variações no
  vendedor, preenchendo `products.source_listing_id` e `product_variants.source_variant_id`
  (colunas sem grant de escrita para o cliente).

Policy extra em `storage.objects`: membros de organizações vendedoras leem imagens de anúncios
visíveis (`private.is_catalog_image`).

> Ordem de verificação importa em dados multi-tenant: índices únicos são checados antes das FKs.
> Prefira unicidade com `organization_id` para que a FK composta recuse dados de outro tenant antes
> que um "duplicate key" revele existência (ver CHANGELOG 0.7.0).

### `public.orders` / `public.order_items` (Fase 8)

Pedido do vendedor. Leitura por membros; **nenhuma escrita direta** — só pelas RPCs. `number`
sequencial por organização (`order_counters`), `request_id` único (idempotência), totais com
`check (total = subtotal + frete − desconto)`. Itens guardam snapshot e `fulfillment`
(`own_stock` | `supplier`, decidido pelo vínculo de origem do produto).

| RPC                           | Efeito                                                                  |
| ----------------------------- | ----------------------------------------------------------------------- |
| `create_order(org, json, id)` | cria `pending` (não mexe em estoque)                                    |
| `confirm_order(id)`           | reserva estoque próprio; cria `supplier_orders` e reserva no fornecedor |
| `ship_order(id)`              | exige fornecedores enviados; baixa estoque próprio (`sale`)             |
| `deliver_order(id)`           | `shipped → delivered`                                                   |
| `cancel_order(id)`            | antes de qualquer envio; libera todas as reservas                       |

### `public.supplier_orders` / `public.supplier_order_items` (Fase 8)

Pedido de fornecimento (um por fornecedor por pedido). Lido pelo fornecedor e pelo vendedor.
Snapshot **mínimo** do destinatário (nome, telefone, documento, endereço). Atacado congelado na
confirmação. `ship_supplier_order(id, transportadora, rastreio)` baixa o estoque do fornecedor.

**Concorrência**: ordem de travas pedido → fornecimento → itens de estoque (por id), igual em
todas as RPCs.

**Funções internas** (`private.reserve_stock`, `release_stock`, `consume_reserved_stock`,
`next_order_number`, `lock_inventory_items`, `order_supplier_sources`) não checam papel e não são
executáveis por `authenticated` — garantido por `rls-baseline.test.ts` (`POLICY_HELPERS`).

### `public.ledger_entries` / `public.order_payments` (Fase 9)

Financeiro manual (sem gateway). `ledger_entries` é o livro-razão **imutável** por organização
(trigger bloqueia update/delete/truncate): valor com sinal (recebimento e crédito de fornecimento

> 0; estorno e pagamento a fornecedor < 0, garantido por CHECK). Só owner/admin leem — membros e
> outras organizações não veem nada. `order_payments` registra cada recebimento/estorno do pedido;
> `orders.paid_cents`/`refunded_cents` são mantidos só pelas RPCs, com constraint
> `líquido (pago − estornado) ≤ total`. `supplier_orders.paid_at` marca o acerto.

RPCs: `record_order_payment` e `refund_order_payment` (idempotentes por `p_request_id`),
`pay_supplier_order` (débito no vendedor + crédito no fornecedor na mesma transação; só depois do
envio; o estado `paid_at` impede repetir) e `finance_summary(org, de, até)`. Erros `finance.*`,
traduzidos em `src/features/finance/api.ts`. Mesma ordem de travas (pedido → fornecimento).

### Integrações de marketplace (Fase 10)

`integration_connections` (conexão por organização vendedora; Shopify e WooCommerce liberados),
`integration_secrets` (segredo do webhook: **sem privilégio algum** para a API),
`listing_links` (SKU do marketplace ↔ item de estoque próprio, sem dropshipping),
`external_orders` (pedido externo → pedido; único por conexão), `integration_events` (log; o
`payload` com dados do cliente não é legível pela API, só `retryable`) e `stock_sync_outbox`
(uma pendência por vínculo, sem privilégio para a API). Leitura só para owner/admin.

- **Entrada de pedidos**: `ingest_marketplace_order` (só service role) → `private.ingest_order`
  → `private.create_order_core`, o **mesmo núcleo** de `create_order`. Retorna `created`,
  `duplicate`, `unmapped`, `invalid` ou `inactive`; nunca lança por dado do pedido (vira evento
  de erro com payload). `retry_integration_event` reprocessa depois de corrigir vínculos.
  Pedidos entram como `pending` (sem reserva de estoque).
- **Saída de estoque**: trigger enfileira o disponível (coalescendo por vínculo);
  `claim_stock_sync`/`complete_stock_sync` (service role) com backoff e desistência após 5 falhas.
  O envio a cada provedor **ainda não existe** (ver CHANGELOG 0.10.0).
- RPCs do vendedor: `create_connection`, `rotate_connection_secret`, `set_connection_status`,
  `link_listing`, `unlink_listing`, `retry_integration_event`. Erros `integrations.*`.

### Analytics (Fase 11)

Sem tabelas: `analytics_overview` (jsonb, chaves por tipo de organização), `analytics_daily` e
`analytics_top_items`. `security definer`, só owner/admin (`org.forbidden` para os demais,
`analytics.invalid_period` fora de 1–366 dias). Dias no fuso `America/Sao_Paulo`.

### Administração (Fase 12)

`organizations.suspended_at`/`suspension_reason` (ambos nulos ou ambos preenchidos).
`private.org_role_of` devolve nulo para organização suspensa — é o gancho de **toda** a RLS e das
RPCs; novas policies devem continuar usando `is_org_member`/`has_org_role` para herdar a suspensão.
`admin_audit_log` é imutável e sem grants. RPCs `admin_*` exigem `profiles.role = 'admin'`
(erro `admin.forbidden`). Toda função que decide visibilidade de fornecedor deve considerar
`suspended_at` (`visible_listing`, `search_catalog`, `is_catalog_image`).

### IA (Fase 13)

`ai_usage` (sem grants; RLS ligada): uma linha por geração (`started` → `done`/`failed`) com tokens.
`ai_begin_description` / `ai_finish` / `ai_usage_today` rodam com o JWT do usuário. Cota diária em
`private.ai_daily_limit()` (50), dia no fuso de São Paulo. O texto gerado nunca é gravado pelo banco.

### Credenciais e envio de estoque (Fase 14)

`integration_credentials` (texto cifrado + `config` não secreto; sem grants para a API; `select` só
para service role). Nenhuma RPC devolve credencial. Agendar o worker (a cada minuto):

```sql
select cron.schedule('stock-sync', '* * * * *', $
  select net.http_post(
    url := 'https://<projeto>.supabase.co/functions/v1/stock-sync',
    headers := jsonb_build_object('x-sync-secret', '<STOCK_SYNC_SECRET>')
  )
$);
```

Implantar `stock-sync` com `--no-verify-jwt` (a autenticação é o segredo do cabeçalho).

### Taxas, comissões e categorias (Fase 15)

Divisão da venda: **venda − taxa do marketplace − valor do fornecedor − comissão do vendedor =
receita da TheSigns**. Nenhuma taxa fica no código; o cálculo é feito só no banco
(`private.compute_split`), e o frontend apenas exibe.

- `categories`: dois níveis (categoria/subcategoria), mantidas pela equipe; todo usuário autenticado
  lê. `catalog_listings.category_id` (fornecedor escolhe; categoria desativada não é atribuída).
- `marketplace_fee_rules`: por marketplace, tipo de anúncio (`classico`, `premium`, `padrao`,
  `live`...), categoria (ou categoria-mãe), faixa de preço unitário `[mín, máx)` e campanha.
  Taxa = `percentual × venda + fixo × quantidade`. Regra com `campaign` **soma** à regra base.
  Mais específica vence: subcategoria > categoria-mãe > geral. Faixas ativas sobrepostas são
  recusadas. Legível por todos; escrita só por RPC da equipe.
- `commission_rules`: comissão do vendedor em pontos-base sobre o preço de venda. Precedência:
  produto (anúncio) > vendedor > subcategoria > categoria-mãe > padrão (15% inicial, não removível).
  **Sem acesso direto** (acordos por vendedor são privados).
- RPCs: `estimate_sale_split` (membros da organização vendedora, anúncio visível; custo = atacado do
  anúncio) e, para a equipe, `admin_simulate_split`, `admin_save_fee_rule`,
  `admin_set_fee_rule_active`, `admin_list_commission_rules`, `admin_save_commission_rule`,
  `admin_delete_commission_rule`, `admin_save_category`, `admin_set_category_active`,
  `admin_search_listings`. Toda alteração grava `admin_audit_log` com resumo legível.
- Erros estáveis `fees.*`, traduzidos em `src/features/fees/fees.ts`.

### Moderação (Fase 16)

- `organizations.approval_status` (`pending`/`approved`/`rejected`) + `approval_reason` e
  `approval_reviewed_at`. Trigger define `pending` para fornecedor novo e `approved` para vendedor.
- `catalog_listings.moderation_status` (`pending`/`approved`/`rejected`/`blocked`) +
  `moderation_reason` e `moderated_at`; anúncio novo nasce `pending`. Sem grant de escrita.
- `private.visible_listing`, `search_catalog` e `private.is_catalog_image` exigem anúncio e
  fornecedor aprovados. `private.is_moderation_image` libera à equipe as imagens de produtos com
  anúncio.
- RPCs: `resubmit_catalog_listing` (owner/admin do fornecedor; só reprovado),
  `request_supplier_review` (proprietário; só reprovado) e, para a equipe, `admin_supplier_reviews`,
  `admin_review_supplier`, `admin_moderation_listings`, `admin_moderate_listing`,
  `admin_update_listing_content`. Erros `moderation.*`.

### Academia (Fase 17)

- Conteúdo: `academy_courses`, `academy_modules`, `academy_lessons` (FK composta com o módulo,
  `youtube_id`, `unlock_rule`, `action_label`/`action_path`), `academy_materials` (arquivo em
  `materials/<aula>/...` ou link https). Policy única: só a equipe (`private.is_platform_admin()`).
- Alunos: `academy_progress` (posição, maior %, conclusão), `academy_unlocks` (pedido/aprovação),
  `academy_certificates` (código, nome e curso congelados) e `academy_questions`. Sem acesso direto;
  tudo por RPCs `academy_*`. Equipe: `admin_academy_*`, `admin_approve_unlock`,
  `admin_issue_certificate`, `admin_answer_question`, `admin_move_academy_item`.
- Regras em `private.academy_unlocked` e `private.academy_summary` (curso concluído = todas as
  obrigatórias). Bucket privado `academy`: leitura via `private.academy_file_readable`.

### Painel do vendedor (Fase 18)

- `profiles.phone`/`document` validados por `private.is_valid_phone` e `private.is_valid_document`
  (check constraints; `authenticated` executa os dois). O trigger de cadastro lê `phone`/`document`
  dos metadados e descarta valor inválido sem impedir a conta.
- `seller_onboarding(org)`: passos calculados (perfil de quem chama completo, produto cadastrado,
  produto ativo, conexão ativa, pedido não cancelado e, se houver curso liberado, uma aula
  concluída). Qualquer membro de vendedor.
- `seller_dashboard(org, dias)`: vendido, lucro bruto, recebido no período e, sem período, a receber
  dos clientes e a pagar aos fornecedores. Owner/admin.
- `analytics_series(org, dias, 'day'|'week'|'month')` (vendedor e fornecedor) e
  `analytics_channels(org, dias)` (vendedor: `manual` ou provedor da conexão). Owner/admin.
- `seller_suggestions(org, limite)`: anúncios visíveis, com estoque e preço sugerido acima do
  atacado, ainda não importados, pela margem sugerida. Qualquer membro de vendedor.

### Central de Vendas e campanhas para lives (Fase 19)

- `sales_materials` (FK composta `(organization_id, listing_id)` → `catalog_listings`): vídeo/imagem
  com `storage_path` em `<anúncio>/<uuid>/<arquivo>` no bucket privado `sales-materials`, ou texto
  (`body`) para roteiro, título, hashtags e argumento. Escrita: `private.can_manage_listing`
  (owner/admin do fornecedor dono, ou equipe); leitura direta: membros do fornecedor e equipe;
  vendedores por `sales_center_listing`. Storage: `private.sales_file_readable`. Máximo 50 por
  anúncio (`sales.too_many_materials`).
- `listing_favorites (user_id, listing_id)`: só os próprios; inserir exige conta vendedora e
  `private.visible_listing` (executável por `authenticated`).
- RPCs do vendedor: `sales_center(sort, busca, limite, offset)` (`trending`/`margin`/`new`/
  `favorites`), `sales_center_listing`, `live_campaigns_for_seller`, `live_campaign_for_seller`,
  `set_live_campaign_participation` (owner/admin).
- `live_campaigns`, `live_campaign_listings`, `live_campaign_participants`: sem grants; equipe usa
  `admin_live_campaigns`, `admin_live_campaign` e `admin_save_live_campaign` (auditoria
  `live_campaign.created`/`updated`). Erros `campaign.*`.
- `private.seller_commission(listing, categoria, vendedor, provedor)`: campanha publicada, no ar,
  com a loja participando e o produto incluído vence as demais regras (fonte `live_campaign`).
  `private.compute_split` passou a usar esta versão.

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
