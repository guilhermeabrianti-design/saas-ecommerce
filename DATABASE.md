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

`integration_connections` (conexão por organização vendedora; só Mercado Livre, Shopee e TikTok Shop — Fase 33),
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

### Ferramentas (Fase 20)

- `pricing_simulate(provedor, tipo, categoria, preço, custo, frete, imposto_bps, antecipação_bps)`
  e `pricing_target(..., margem_bps)`: qualquer usuário autenticado; usam `private.match_fee_rule`
  (Fase 15). Erros `pricing.invalid`, `pricing.unreachable`, `fees.not_configured`.
- `ai_begin_generation(org, produto, tipo, orientação)`: tipos `title`, `ad_copy`, `video_script`,
  `live_script`; owner/admin; mesma cota de `ai_begin_description` via `private.ai_reserve`
  (`ai_usage.feature` = tipo). Erro `ai.invalid`.

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

### Estoque por planilha e ERP (Fase 36)

`bulk_set_stock(org, [{sku, quantity}])` (owner/admin, até 5000 linhas, 20 por hora): cada SKU de
estoque próprio vira contagem (`count`); nunca abaixo do reservado. ERPs (Bling por OAuth, Tiny por
token) usam `integration_connections` (`provider` `bling`/`tiny`, `sync_cursor`, `last_sync_*`) e
a Edge Function `erp`. Agendar a cada 15 minutos (mesmo segredo do worker de estoque):

```sql
select cron.schedule('erp-sync', '*/15 * * * *', $
  select net.http_post(
    url := 'https://<projeto>.supabase.co/functions/v1/erp/cron',
    headers := jsonb_build_object('x-sync-secret', '<STOCK_SYNC_SECRET>')
  )
$);
```

Implantar `erp` com `--no-verify-jwt` (callback do Bling e cron; as demais rotas conferem o JWT).

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

### Checkout próprio (Fase 21)

- `orders.channel` (`manual` | `marketplace` | `checkout`): pedidos de marketplace marcados pelo
  trigger de `external_orders`. Pedidos `checkout` recusam `confirm_order`, `cancel_order`,
  `record_order_payment` e `refund_order_payment` (`orders.checkout_managed`): quem decide é o pagamento.
  Os núcleos `private.confirm_order_core` / `private.cancel_order_core` são compartilhados.
- `products.checkout_enabled`: só pela RPC `set_product_checkout` (owner/admin, produto importado do
  catálogo, ativo, anúncio visível). `checkout_product_summary` mostra comissão e motivo de bloqueio.
- `checkout_payments` (1 por pedido): pagamento no Mercado Pago (`external_id`, meio, situação, taxa,
  PIX/boleto, `needs_refund`). Owner/admin do vendedor leem colunas sem token/PIX; escrita só pelo
  service role. `public_token` = consulta do comprador por `checkout_order_status` (única RPC de `anon`).
- `order_splits` (1 por pedido): divisão congelada na criação (comissão e regra) e fechada na
  aprovação com a taxa real e o atacado dos pedidos de fornecimento. Owner/admin do vendedor leem.
- `platform_ledger_entries`: receita da TheSigns (`checkout_revenue` / `checkout_reversal`), imutável,
  sem acesso pela API (equipe via `admin_checkout_summary`).
- `ledger_entries`: novos tipos `checkout_commission` (vendedor, +), `checkout_supplier` (fornecedor, +)
  e `checkout_reversal` (−). Na aprovação `supplier_orders.paid_at` é preenchido (a plataforma acerta).
- Service role (Edge Function `checkout`): `checkout_offer`, `checkout_create_order` (idempotente
  por `request_id`; sem reserva antes do pagamento; limpa tentativas sem pagamento com mais de 1 h;
  até 100 pendentes/hora por loja), `checkout_sync_payment` (máquina de estados idempotente:
  aprovado → confirma e lança; sem estoque/valor divergente → `refund_required`; recusado/vencido →
  cancela; estornado/contestado → desfaz, fornecedor que já enviou fica com o atacado) e
  `checkout_abandon`.
- Equipe: `admin_checkout_summary`, `admin_checkout_payments`, `admin_checkout_refund_begin`
  (auditoria `checkout.refund`; só antes de o fornecedor enviar).

### Carteira e saques (Fase 22)

- Carteira = visão de `ledger_entries` só com o dinheiro que passou pela plataforma
  (`checkout_commission`, `checkout_supplier`, `checkout_reversal`, `withdrawal`). Lançamentos
  manuais da Fase 9 ficam fora. Saldos em `private.wallet_balance` (sem coluna de saldo).
- Liberação por pedido (`private.order_release_at`): o que vier primeiro entre entrega + N dias e
  último envio do fornecedor + M dias. Estorno/contestação do mesmo pedido se compensa com ele;
  depois da liberação, reduz o disponível (que pode ficar negativo).
- `wallet_settings` (linha única): N, M e saque mínimo. Leitura para contas conectadas; escrita só
  por `admin_save_wallet_settings` (auditada `wallet.settings`).
- `withdrawal_requests`: `requested → approved → paid`, ou `rejected` / `cancelled`. Chave PIX
  normalizada e validada no banco (`private.is_valid_pix_key`), titular com CPF/CNPJ válido.
  Owner/admin da organização leem; escrita só por RPC.
- Organização: `wallet_summary`, `wallet_pending` (owner/admin), `request_withdrawal` (só owner;
  idempotente por `request_id`; trava consultiva por organização contra saque duplo) e
  `cancel_withdrawal` (só owner, enquanto solicitado).
- Equipe: `admin_withdrawals_overview`, `admin_withdrawals`, `admin_approve_withdrawal` (disponível
  não pode ficar negativo; organização suspensa não), `admin_reject_withdrawal` (com motivo) e
  `admin_pay_withdrawal` (identificador da transferência; lança `withdrawal` negativo com
  `request_id` = id do saque). Tudo auditado (`wallet.*`).

### Afiliados e indicação (Fase 23)

- `organizations.public_code`: código público (4–32, minúsculas/dígitos/hífen), gerado na criação e
  trocado só pelo owner (`set_public_code`). É o endereço da vitrine (`/loja/<código>`) e o código
  de indicação.
- `affiliate_links`: links de divulgação do vendedor (`/r/<código>`), destino = produto da própria
  loja ou vitrine. Membros leem; `create_affiliate_link` / `update_affiliate_link` (owner/admin;
  código e destino imutáveis, só nome e pausa).
- `affiliate_visits`: uma linha por organização, link (nulo = vitrine), dia e hash do visitante;
  cliques somam até 1000. Sem acesso direto; gravada só por `affiliate_record_visit` (service role).
- `order_attributions`: origem de um pedido do checkout (`link` ou `store`), gravada por
  `checkout_attribute_order` (service role; só link ativo da mesma loja; primeira origem vale).
  Owner/admin leem.
- `affiliate_stats` (owner/admin): cliques, visitas, pedidos, pagos, valor e comissão por origem
  (vitrine, cada link, acesso direto) no período.
- Público (service role, via Edge Function `checkout`): `store_public`, `affiliate_link_target`,
  `affiliate_record_visit`, `checkout_attribute_order`.
- `referral_settings` (linha única, nasce desligada): recompensa, venda mínima e prazo; escrita só
  por `admin_save_referral_settings` (auditada `referral.settings`).
- `organization_referrals`: quem indicou cada organização, com a regra congelada. Registrada por
  `create_organization(p_name, p_referral_code)` (atômico) ou `apply_referral_code` (owner, até 30
  dias e antes da primeira venda). Recusa autoindicação (mesmo criador ou membro em comum).
- Recompensa: `private.checkout_settle` chama `private.referral_reward` — primeira venda paga da
  indicada (vendedor do pedido ou fornecedor que recebeu por ele), dentro do prazo e acima do
  mínimo: `referral_reward` positivo no razão de quem indicou (`order_id` = pedido que gerou,
  liberado com ele na carteira) e `referral_reward` negativo em `platform_ledger_entries`. Estorno
  do pedido (`private.referral_reverse`) lança `checkout_reversal` e `referral_reversal`, e a
  indicação volta a esperar uma venda.
- Consultas: `referral_summary` (owner/admin), `admin_referrals_overview`, `admin_referrals`.

### Notificações (Fase 24)

- `notifications`: uma linha por destinatário (`user_id`), `organization_id` nulo = equipe. RLS:
  só o destinatário, e só enquanto for membro da organização. Sem escrita direta; publicada em
  `supabase_realtime`. `link` restrito a caminho interno. Retenção de 90 dias (limpeza a cada envio).
- Envio só por gatilhos (`private.notify_org` com papéis, `private.notify_staff`):
  `inventory_items` (baixo/esgotado/de volta, na passagem do limite), `catalog_listings` (preço,
  disponibilidade, moderação), `products.status` e `organizations` (fornecedor em análise,
  suspenso), `supplier_orders`, `external_orders`, `checkout_payments`, `withdrawal_requests`,
  `organization_referrals`.
- RPCs: `mark_notifications_read(p_ids)`, `mark_all_notifications_read(p_org)` (só as próprias).

### Rate limiting e MFA (Fase 26)

- `private.rate_limits` (bucket, assunto, início da janela, contagem) — fora da API, sem RLS
  necessária. `private.rate_limit` conta e responde; `private.enforce_rate_limit` levanta
  `rate_limited`; `private.limit_inserts(bucket, coluna, limite, janela)` é o gatilho genérico
  (`organization_invitations`, `withdrawal_requests`, `affiliate_links`, `academy_questions`,
  `products`). `public.rate_limit_hit` só para o service role (Edge Function, por hash do IP).
- `private.current_aal()` lê `auth.jwt() ->> 'aal'`; `private.is_platform_admin()` exige `aal2`.

### Suporte e denúncias (Fase 27)

- `support_tickets` (número sequencial, categoria `ticket_category`, estado `ticket_status`,
  pedido e denunciado opcionais) e `support_messages` (imutáveis, `from_staff`). RLS: quem abriu
  ou a equipe (`is_platform_admin`, aal2). Escrita só por RPC; limites por gatilho (Fase 26).
- RPCs: `create_support_ticket`, `reply_support_ticket`, `close_support_ticket`;
  equipe: `admin_support_overview`, `admin_support_tickets`, `admin_support_ticket_context`.
- `private.notify_user` envia notificação para uma pessoa (sem organização).

### Avaliações e reputação (Fase 28)

- `reviews`: alvo (organização), origem `buyer` (pedido do checkout, único) ou `seller` (pedido de
  fornecimento, único), nota 1–5, comentário, resposta única, ocultação com motivo. RLS ligada sem
  policy: leitura só pelas RPCs.
- Métricas em `private.org_reputation` (90 dias); avaliações visíveis em `private.org_reviews`.
- RPCs: `organization_reputation` (membros, equipe, fornecedores ativos), `listing_supplier_reputation`,
  `review_supplier_order`, `my_supplier_reviews`, `reply_review`; equipe: `admin_reviews`,
  `admin_set_review_hidden` (auditada `review.hide`/`review.show`). Service role:
  `checkout_submit_review`, `store_rating`. `checkout_order_status` ganhou `can_review` e `review`.

### Anúncios e publicação (Fase 29)

- `channel_listings` (conexão × produto, único): título, descrição, preço opcional, estado
  `channel_listing_status` (draft, publishing, active, paused, error), execução em andamento
  (`run_id`, `run_action`), id/URL no marketplace. `channel_listing_steps`: etapas de cada execução.
  Owner/admin leem; escrita só por RPC.
- Vendedor: `save_channel_listing`, `duplicate_channel_listing`, `delete_channel_listing` (só
  rascunho nunca publicado), `channel_listing_begin` (valida e devolve variações com SKU, preço,
  disponível e opções). Service role (Edge Function `listings`): `channel_listing_step`,
  `channel_listing_finish` (cria os `listing_links` e registra `integration_events`).
- Estoque anunciável: `private.link_available` (do fornecedor quando importado);
  `inventory_items_enqueue_dropship_sync` enfileira no `stock_sync_outbox` as cópias importadas
  vinculadas quando o estoque do fornecedor muda.

### Etiquetas de envio (Fase 30)

- Bucket privado `shipping-labels` (PDF/PNG/JPG, 5 MB), pasta `so-<fornecimento>` ou `o-<pedido>`;
  policies de leitura e envio por `private.label_file_access` (quem participa do envio, via
  `private.shipment_org`). Sem exclusão de arquivo: anula-se o registro.
- `shipping_labels`: envio (fornecimento XOR pedido), caminho, nome, transportadora, rastreio,
  quem enviou, anulação. RLS: quem participa do envio. RPCs `register_shipping_label` (confere a
  pasta e a existência do arquivo; avisa o outro lado) e `void_shipping_label`.

### Mercado Livre (Fase 31)

- `oauth_states` (sem privilégio para a API): estado, organização, quem começou, `code_verifier`,
  uso único em 10 minutos. `oauth_begin` (owner/admin do vendedor); service role: `oauth_consume`,
  `oauth_complete` (cria/reativa a conexão; conta do Mercado Livre em uma loja por vez),
  `put_connection_credentials`, `swap_connection_credentials` (grava tokens renovados só na versão
  esperada em `config.token_version`), `mercadolivre_connection` (conexão pelo id do usuário).
- `link_listing` passou a aceitar itens de produto importado e enfileira `private.link_available`.

### Publicar no Mercado Livre (Fase 37)

- `product_channel_configs` ganhou `attributes` (atributos da categoria, `[{id, value_id?, value_name?}]`,
  sem SELLER_SKU/ITEM_CONDITION, que a publicação preenche), `variation_map` ("Cor" → COLOR) e o
  estado da publicação: `connection_id` (conta onde o anúncio vive), `external_id`, `external_url`,
  `publish_status` (publishing, active, paused, closed, error), `publish_run`/`publish_action`/
  `publish_started_at` (execução em andamento; libera após 10 min), `last_error`, `published_at`.
- Vendedor (owner/admin): `save_ml_listing_attributes`, `ml_publish_begin` (confere canal, categoria,
  conexão e estado; devolve título, preço, tipo, atributos, variações ativas com SKU e disponível,
  fotos — as do fornecedor quando o importado não tem) e `ml_lookup_allowed` (consultas de
  categoria, 120/10 min). Service role (Edge Function `mercadolivre`): `ml_publish_finish` (só a
  execução em andamento; grava o anúncio e cria/atualiza os `listing_links` com o SKU; na falha volta
  ao estado anterior ou "error").

### Shopee (Fase 38)

- `oauth_begin` aceita `shopee` (só vendedor); a conexão usa o mesmo `oauth_states`/`oauth_complete`
  (loja da Shopee em uma empresa por vez). `marketplace_connection(provider, conta)` acha a conexão
  ativa pelas notificações (service role).
- `listing_links.external_ref`: referência do item no marketplace (Shopee: `item_id:model_id`),
  guardada por `remember_listing_refs` (service role; pedidos e worker de estoque) e esquecida ao
  trocar o SKU do vínculo. `claim_stock_sync` passou a devolver `link_id` e `external_ref`.
- Documentos de marketplace deixam de ser só do Mercado Livre: `shipping_labels.source` aceita
  `shopee`; unicidade por envio × origem × tipo × referência; `attach_marketplace_document` ganhou
  `p_source` e `p_carrier`. `marketplace_forward_order` (service role) é o encaminhamento do
  Mercado Livre sem envio; `existing` considera só documentos da mesma origem.
- Botão do pedido: `order_marketplace` (membros do vendedor: de onde veio o pedido) e
  `marketplace_documents_request` (limite de 20/10 min; devolve conexão, pedido e conta).

### TikTok Shop (Fase 39)

- `oauth_begin` aceita `tiktok` (só vendedor). A conexão guarda a loja (id) e, junto das
  credenciais cifradas, o `shop_cipher` e a região em `integration_credentials.config`.
- `shipping_labels.source` aceita `tiktok` (etiqueta por pacote: `external_ref` = id do pacote);
  `attach_marketplace_document` com transportadora e avisos da TikTok Shop.
- Estoque: `listing_links.external_ref` = `produto:sku:depósito`.

### Gamificação (Fase 41)

- `gamification_rules` (evento, rótulo, tipo de conta, pontos, limite diário, ativa),
  `gamification_levels` (nome e pontos mínimos), `gamification_achievements` (evento e quantidade).
  `gamification_points`: livro imutável e idempotente (organização × evento × origem; estorno com
  `rev:<origem>`). `organization_achievements`: quando cada conquista foi ganha.
  `organizations.show_in_ranking`. Nada disso é lido direto pela API.
- Gatilhos (`private.gami_award`/`gami_revoke`): venda entregue de checkout ou marketplace (manual
  não conta; cancelada depois estorna), envio do fornecedor de venda real, avaliação 5 estrelas
  (ocultada estorna), aula concluída, anúncio publicado no catálogo e no Mercado Livre (uma vez por
  anúncio), indicação recompensada (estorno da recompensa estorna). Sobe de nível e conquista avisam
  por notificação (`gamification.level`, `gamification.achievement`).
- Membros: `gamification_summary`, `gamification_ranking` (mês, mesmo tipo de conta, top 10 + a
  própria posição); proprietário: `set_ranking_visibility`. Equipe: `admin_gamification_config`,
  `admin_save_gamification_rule`, `admin_save_gamification_levels`, `admin_save_achievement`
  (auditadas).

### Planos e monetização (Fase 42)

- `plans` (tipo de conta, preço mensal, gerações de IA por dia, máximo de produtos, vagas de
  destaque, ativo). Um gratuito padrão por tipo (`is_default`, preço 0, sempre ativo); planos pagos
  só pela equipe (`admin_save_plan`, auditada), a partir de R$ 1,00.
- `organization_subscriptions`: assinatura no Mercado Pago (`external_id` = preapproval), preço
  congelado na assinatura, estado (`pending`, `authorized`, `paused`, `cancelled`), próxima cobrança
  e `access_until` (cancelada vale até a cobrança que não vai acontecer). No máximo uma em
  andamento e uma vigente por empresa. `subscription_payments`: cobranças mensais.
- `private.org_plan(org)`: plano vigente (assinatura autorizada ou cancelada no prazo; senão o
  gratuito). Limites: IA em `private.ai_reserve`/`ai_usage_today`; produtos não arquivados no
  gatilho `products_plan_limit` (`plans.product_limit`); destaque em `catalog_featured`
  (`set_listing_featured`, `listing_featured_status`) — só os primeiros marcados até as vagas
  contam, e `catalog_browse` devolve `featured` e os ordena primeiro.
- Membros: `billing_overview`, `billing_refresh_targets`; proprietário: `billing_begin_subscription`,
  `billing_cancel_begin`. Só service role (Edge Function `billing`): `billing_attach_checkout`,
  `billing_sync_subscription` (valor divergente cancela; troca de plano devolve a anterior para
  cancelar), `billing_record_payment`. Equipe: `admin_billing_overview`, `admin_save_plan`.
  Notificações `billing.active`, `billing.cancelled`, `billing.payment_failed`.

### Campanhas patrocinadas (Fase 43)

- `sponsorship_packages` (espaço `catalog`/`sales_center`, dias, preço, `max_active` = campanhas
  ao mesmo tempo, à venda): só a equipe (`admin_save_sponsorship_package`, auditada).
- `sponsored_campaigns`: compra de um fornecedor para um anúncio, com as condições do pacote
  congeladas; `pending` → `active` (`starts_at`/`ends_at`) na aprovação; `cancelled` (trocada) ou
  `refunded` (estorno/contestação). Uma em andamento por anúncio e espaço.
  `sponsorship_views`: lojas (empresas) que abriram o anúncio durante a campanha.
- `private.live_sponsored(espaço)`: no ar agora. `catalog_browse` e `sales_center` devolvem
  `sponsored` e os ordenam primeiro (fora de Favoritos).
- Fornecedor: `sponsorship_overview` (pacotes com esgotado, anúncios visíveis, campanhas com
  aberturas e importações), `sponsorship_begin` (owner/admin), `sponsorship_is_mine`. Vendedor:
  `sponsorship_record_view`. Só service role: `sponsorship_attach_checkout`,
  `sponsorship_sync_payment` (pede estorno se valor divergente, duplicado, compra trocada ou vagas
  esgotadas). Equipe: `admin_sponsorship_overview`. Notificação `sponsorship.active`.

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
