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
- Fase 33: a Edge Function `webhooks` (Shopify/WooCommerce), os segredos de webhook e as
  credenciais de API desses canais foram removidos. Pedidos chegam só pelas notificações do
  Mercado Livre (relidas na API com o token cifrado).
- Fase 33: vendedor e fornecedor não se identificam. O vendedor vê o fornecedor por apelido
  estável (`private.supplier_alias`) em todas as RPCs do catálogo, da Central de Vendas e da
  reputação; o fornecedor vê "Vendedor verificado". Só a própria organização e a equipe veem o nome.

## Implementado (Fase 12)

- Papel `admin` da equipe só via SQL; RPCs administrativas checam o papel no servidor. A equipe
  enxerga **agregados**, nunca dados de negócio (teste de isolamento).
- Suspensão com motivo obrigatório e trilha de auditoria imutável (sem grants, sem UPDATE/DELETE).
- Suspensão aplicada no helper central de autorização: uma organização suspensa não lê nem escreve
  nada (nem via RPC de outro tenant que dependa dela: catálogo, roteirização, webhooks).
- Pendente: MFA obrigatório para contas da equipe; alerta por e-mail em ações administrativas.

## Implementado (Fase 13)

- Chave da Anthropic só como segredo da Edge Function (`ANTHROPIC_API_KEY`); nunca no navegador.
- A função usa o JWT do usuário: mesma autorização das RPCs (owner/admin, produto da organização),
  cota por organização com lock e devolução em caso de falha; log de uso sem acesso pela API.
- O servidor relê o produto do banco (o cliente não envia o conteúdo do prompt). Campos do
  vendedor são achatados e limitados; a saída é só texto mostrado a quem a pediu, para revisão.
- Pendente: rate limit por usuário (hoje só a cota diária da organização); CAPTCHA/abuso por conta nova.

## Implementado (Fase 14)

- Credenciais de marketplace criptografadas (AES-256-GCM) com chave que o banco nunca vê; ligadas ao
  id da conexão; nunca devolvidas, exibidas ou registradas em log; apagadas ao desconectar.
- Worker autenticado por segredo compartilhado (comparação em tempo constante); credenciais só
  decifradas em memória.
- Anti-SSRF nas chamadas de saída (só a API do Mercado Livre, caminhos validados, sem redirecionamento).
- Pendente: rotação de chave em lote; restrição de rede de saída; teste de conexão.

### Configuração obrigatória no projeto Supabase cloud

`supabase/config.toml` vale só para o ambiente local. Em staging/produção, replique no painel
(Authentication → Providers/Policies/Rate limits/URL configuration):

- Confirm email: **on** · Secure password change: **on**
- Minimum password length: **10** · Password requirements: **lowercase, uppercase, digits**
- Rate limit de sign-in/sign-up: **15 / 5 min por IP**
- Site URL e Redirect URLs: domínio do ambiente (`/entrar`, `/redefinir-senha`)
- SMTP próprio (o SMTP padrão do Supabase tem limite baixo e não é para produção)
- Recomendado antes de abrir cadastro público: CAPTCHA (Turnstile/hCaptcha) — ainda não integrado.

## Implementado (Fase 21)

- Checkout sem conta: toda escrita passa pela Edge Function `checkout` com o service role; o banco
  valida produto, estoque, preço e comprador. O valor cobrado vem do pedido no banco, nunca do navegador.
- Cartão só no Payment Brick (iframe do Mercado Pago): o sistema recebe apenas o token de uso único.
- Webhook: assinatura `x-signature` (HMAC-SHA256, comparação em tempo constante) e o estado é sempre
  relido na API do Mercado Pago; aplicação idempotente (repetições não lançam duas vezes).
- Idempotência também na criação (`X-Idempotency-Key` = id do pedido) e no estorno.
- Comprador consulta o pedido por token aleatório (sem id do pedido, e-mail ou documento na URL); o
  código PIX some depois que deixa de valer.
- Estorno pela equipe exige JWT de admin, é auditado e só vale antes de o fornecedor enviar.
- Pendente: rate limit por IP no checkout (Fase 26; hoje só limite por loja no banco), CAPTCHA.

## Implementado (Fase 22)

- Saldo sempre calculado a partir do livro-razão imutável; não há coluna de saldo para adulterar.
- Saque só pelo proprietário, com trava por organização (dois pedidos simultâneos não gastam o mesmo
  saldo) e idempotência por `request_id`. O disponível é conferido de novo na aprovação.
- Débito no razão só quando a equipe registra o pagamento, com o identificador da transferência;
  aprovar, recusar, pagar e mudar as regras ficam na auditoria.
- Chave PIX e documento do titular visíveis só para owner/admin da organização e para a equipe.
- Risco conhecido: a entrega é marcada pelo vendedor. O prazo após a entrega (padrão 7 dias) é a
  proteção; a equipe pode aumentá-lo.

## Implementado (Fase 23)

- Vitrine, destino de link, contagem de visitas e atribuição só pela Edge Function com o service
  role; nenhuma dessas funções é executável por `anon` ou contas conectadas.
- Visitante identificado por um id aleatório do navegador, guardado só como hash SHA-256; nada de
  IP, e-mail ou documento nas estatísticas.
- Atribuição informativa: só aceita link ativo da mesma loja do pedido e não move dinheiro.
- Indicação: recusa autoindicação (mesmo criador ou membro em comum), vale só para organizações
  novas e antes da primeira venda, paga só depois de venda aprovada e é desfeita no estorno. O
  crédito segue a garantia da carteira. Regras mudam só pela equipe, com auditoria.
- Riscos conhecidos: visitas podem ser infladas com ids falsos (rate limit por IP na Fase 26);
  indicação combinada entre contas de pessoas diferentes não é detectável — a equipe deve manter a
  recompensa abaixo da margem da TheSigns na venda mínima.

## Implementado (Fase 24)

- Notificações só nascem de gatilhos no banco; o navegador não cria nem altera (só marca as
  próprias como lidas por RPC).
- Destinatário por linha + RLS: o Realtime entrega a cada usuário só o que ele pode ler. Quem sai
  da organização deixa de ver as notificações dela.
- Valores em dinheiro só para owner/admin; `link` aceita só caminho interno (banco e tela recusam
  URL externa e `//host`).

## Implementado (Fase 26)

- MFA (TOTP) obrigatório para a equipe: `private.is_platform_admin()` exige `aal2` no JWT, então
  nenhuma RPC ou policy da administração funciona só com a senha — nem chamando a API direto.
- Quem ativa o segundo fator passa a precisar do código em todo login (`/verificacao`).
- Rate limiting no banco (`private.rate_limits`, fora da API) por organização/usuário nas escritas
  repetíveis, e por IP (hash SHA-256, nunca o IP) nas rotas públicas do checkout.
- Pendente: CSP e cabeçalhos de segurança (dependem da hospedagem do frontend), CAPTCHA no
  cadastro, CORS restrito por origem nas Edge Functions.

## Implementado (Fase 37)

- Publicar no Mercado Livre só por owner/admin do vendedor, com limite (30 execuções/10 min por
  usuário). O navegador nunca recebe o token do Mercado Livre: a Edge Function confere o JWT pela RPC
  `ml_publish_begin` e só depois usa o token cifrado da conexão.
- Uma execução por anúncio (`publish_run`); só ela conclui, e só pelo service role. Vínculos de SKU
  só para itens de estoque do próprio produto.
- Fotos vão ao Mercado Livre por URL assinada de 1 hora (o bucket continua privado). Link do anúncio
  gravado só se for `https://`. Chamadas de saída só para a API do Mercado Livre, sem redirecionamento.

## Implementado (Fase 38)

- Shopee: push aceito só com a assinatura `HMAC-SHA256(partner_key, url|corpo)` (comparação em
  tempo constante), para uma loja conectada e ativa; o pedido é sempre relido na API com o token
  da loja. Tokens (acesso de 4 h, renovação de 30 dias) cifrados como os do Mercado Livre, com a
  mesma renovação versionada. A partner key nunca sai das Edge Functions.
- O `state` da autorização vai no endereço de volta (a Shopee não tem parâmetro próprio) e vale
  uma vez em 10 minutos, como no Mercado Livre. O navegador só segue para `partner.shopeemobile.com`
  (ou o sandbox).
- Etiqueta baixada só da API da Shopee, conferida como PDF de até 5 MB, gravada na pasta do envio.
  Chamadas de saída só para o host da Shopee, sem redirecionamento.

## Implementado (Fase 39)

- TikTok Shop: webhook aceito só com a assinatura `HMAC-SHA256(app_secret, app_key + corpo)`
  (tempo constante), para uma loja conectada e ativa; pedido sempre relido na API. Chamadas da loja
  assinadas com a app secret; o token vai em cabeçalho, nunca na URL. Tokens cifrados com a mesma
  renovação versionada; `shop_cipher` guardado junto (não é segredo, mas não sai do servidor).
- Etiqueta baixada só de hosts da TikTok Shop (`https`, sem redirecionamento), conferida como PDF
  de até 5 MB. O navegador só segue para `services.tiktokshop.com` ao autorizar.

## Implementado (Fase 44)

- Publicar na Shopee e na TikTok Shop com as mesmas travas do Mercado Livre: só owner/admin do
  vendedor, limite de 30 execuções/10 min por usuário e marketplace, uma execução por anúncio,
  conclusão só pelo service role e vínculos só para itens do próprio produto.
- Consultas de categoria usam o token da loja só no servidor, depois de `marketplace_lookup_connection`
  conferir o papel e aplicar o limite. Fotos saem do bucket privado direto para a API do
  marketplace (sem URL pública).

## Implementado (Fase 41)

- Pontos só nascem de gatilhos no banco sobre eventos reais; o navegador não lança nem altera nada.
  Pedido manual não pontua (evita inflar o ranking), cada origem pontua uma vez e cada evento tem
  limite diário configurável. Livro de pontos imutável.
- Ranking sem expor quem não quer: vendedor aparece pelo nome só se o proprietário escolher;
  fornecedor sempre pelo apelido; cada tipo de conta só vê o próprio ranking.

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
