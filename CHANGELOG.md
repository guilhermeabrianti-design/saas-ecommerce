# Changelog

## [0.37.0] — Fase 37: Publicar no Mercado Livre

### Adicionado

- **Publicar direto no Mercado Livre** pelo produto: em **Exportar para Mercado Livre**, depois de
  salvar o canal, aparece o painel **Publicar no Mercado Livre** com o estado do anúncio, o link
  para ele e o último erro, se houver.
- **Sugerir categoria pelo título**: busca no Mercado Livre e preenche o código (ex.: MLB31447).
- **Atributos da categoria**: a tela carrega o que a categoria pede — obrigatórios primeiro, com as
  opções do Mercado Livre em lista; marca e código de barras do cadastro entram sozinhos.
- **Variações**: cada característica (Cor, Tamanho…) é associada a um atributo de variação do
  Mercado Livre, com palpite automático pelo nome. Todas saem com o preço do canal (regra do
  Mercado Livre); variação nova sem estoque fica de fora e o aviso diz quais.
- **Publicar, Atualizar anúncio, Pausar e Reativar.** Antes de chamar a API, a TheSigns confere o
  que o Mercado Livre recusaria (foto, estoque, categoria, obrigatórios, variações) e mostra a lista.
  Fotos do produto (ou do fornecedor, no importado), descrição em texto e frete pelo Mercado Envios.
- Ao publicar, cada SKU fica vinculado: **pedidos desse anúncio entram sozinhos** e o **estoque
  sincroniza** (inclusive o do fornecedor no dropshipping).
- **Testes**: 9 de banco, 11 do módulo de publicação e 4 de frontend.

### Limitações conhecidas

- **Não exercitado contra contas reais** (respostas simuladas). Depende do mesmo app do Mercado
  Livre da Fase 31 (`MERCADOLIVRE_CLIENT_ID`/`MERCADOLIVRE_CLIENT_SECRET`/`APP_URL`).
- Título só muda enquanto o anúncio não tem vendas; categoria e tipo de anúncio não mudam depois de
  publicado (regra do Mercado Livre). Medidas do pacote não são enviadas.

## [0.36.0] — Fase 36: Estoque sincronizado (planilha, Bling e Tiny)

### Adicionado

- **Estoque › Sincronizar estoque** (vendedor e fornecedor, owner/admin): vendeu em outro lugar, o
  estoque daqui acompanha sem ajuste manual — e segue para o Mercado Livre pela fila de estoque.
- **Planilha (CSV)**: SKU e quantidade, com ou sem cabeçalho, separador ; , ou tab (o que o Excel e
  os ERPs exportam). Prévia antes de aplicar, resumo do que mudou, SKUs não encontrados e itens que
  ficaram no mínimo reservado por pedidos em aberto. Botão **Baixar modelo com meu estoque**.
- **Bling** (OAuth): o saldo do Bling (`saldoVirtualTotal`) dos mesmos SKUs passa a valer aqui.
- **Tiny / Olist ERP** (token da API): lê as atualizações de estoque desde a última leitura.
- Sincronização automática a cada 15 min (agendamento) e botão **Sincronizar agora**; cada rodada
  fica no histórico do item como contagem ("Sincronizado do Bling/Tiny").
- **Testes**: 4 de banco, 7 do módulo de ERP e 5 de frontend.

### Para ativar

- Bling: criar o app em developer.bling.com.br com a URL de retorno
  `<SUPABASE_URL>/functions/v1/erp/callback` e cadastrar `BLING_CLIENT_ID`/`BLING_CLIENT_SECRET`.
- Agendar `erp/cron` (ver DATABASE.md). Tiny: o vendedor instala a extensão "API para estoque em
  tempo real" e cola o token.

### Limitações conhecidas

- **Não exercitado contra contas reais** (respostas simuladas). Só estoque próprio (dropshipping usa
  o estoque do fornecedor). O ERP manda no saldo: ajuste manual aqui é sobrescrito na próxima
  sincronização.

## [0.35.0] — Fase 35: Catálogo aberto, lojas de fornecedores e exportar com ferramentas

### Alterado

- **Publicou, apareceu**: fornecedor novo e anúncio novo não passam mais por aprovação — o produto
  aparece na hora no catálogo dos vendedores. O que estava "em análise" foi liberado. A equipe
  ainda pode reprovar ou bloquear depois pela Moderação (agora também fornecedor já aprovado).
- **Financeiro saiu**: fica só a **Carteira**. Atalhos do painel apontam para Carteira e Pedidos.
- **Ferramentas e configuração do anúncio só ao exportar**: o menu "Ferramentas" saiu. No produto,
  a seção **Exportar para marketplaces** mostra os botões Mercado Livre, Shopee e TikTok Shop; ao
  escolher um, aparecem o anúncio daquele canal e as ferramentas (preço ideal, simulador de lucro
  e textos com IA) já com o produto, o custo e o preço.

### Adicionado

- **Lojas de fornecedores** no catálogo: aba **Lojas** (apelido, nota, quantidade de produtos e
  capa) e página de cada loja com todos os anúncios. Cada produto do catálogo leva à loja dele.
  A busca encontra pelo apelido da loja (não pelo nome real).
- **Testes**: vitrine e lojas no banco; moderação ajustada ao novo fluxo.

## [0.34.2] — Empresa e convite por link

### Alterado

- **Não existe mais "organização" para criar, procurar ou entrar.** Cada conta já é a sua empresa
  (criada no primeiro acesso). O menu mostra **Empresa**, com dados, equipe e convites; o seletor de
  organização, a tela "Criar organização" e a lista de convites pendentes saíram.
- **Convite por link**: o proprietário (ou admin) escolhe o acesso (Administrador ou Membro) e
  copia o link. Quem abre cria a conta — o tipo (vendedor/fornecedor) vem da empresa — e já está
  dentro. Quem já tem conta entra pelo mesmo link. Link de uso único, válido por 7 dias e
  cancelável.
- Uma conta, uma empresa: quem abre o link com uma empresa vazia (a criada automaticamente) troca
  por esta; com dados, o link é recusado com explicação.
- Textos das telas: "organização" virou "empresa".

## [0.34.1] — Organização automática no primeiro acesso

### Corrigido

- Conta sem organização (vendedor ou fornecedor) não fica mais presa na tela "Criar organização":
  a organização é criada na hora, do tipo da conta, com nome provisório ("Loja de Ana" /
  "Fornecedor Ana Souza") que pode ser trocado em Organização. Idempotente (não cria duas) e um
  código de indicação inválido não impede. Fornecedor novo continua passando pela aprovação da
  equipe para aparecer no catálogo.

## [0.34.0] — Fase 34: Configuração por canal no cadastro do produto

### Adicionado

- **Canais de venda no produto** (só vendedor): ao cadastrar ou importar, o produto já mostra uma
  aba por canal — Mercado Livre, Shopee e TikTok Shop — com título (no limite de cada canal: 60,
  120 e 255), preço, tipo de anúncio, categoria e frete grátis **pré-preenchidos** a partir do
  produto. O vendedor revisa e salva; "vender neste canal" liga/desliga sem perder o preenchido.
- **Taxa e lucro estimado** em cada canal, com as mesmas regras de taxa das ferramentas de preço
  (custo = custo do produto; antes de impostos e frete).
- Aviso do Mercado Livre: frete grátis obrigatório a partir de R$ 79.
- Tipo de anúncio só entre os que têm taxa ativa cadastrada pela equipe (Shopee comum aparece
  como "taxa não cadastrada" até a equipe cadastrar).
- **Testes**: 4 de banco e 5 de frontend.

### Limitações conhecidas

- Publicar no marketplace a partir desta configuração ainda não (próxima fase: Mercado Livre).

## [0.33.0] — Fase 33: Ambientes separados e só Mercado Livre, Shopee e TikTok Shop

### Alterado

- **Vendedor e fornecedor não se identificam.** O vendedor vê cada fornecedor por um apelido
  estável ("Fornecedor 3F9A1C") no catálogo, no painel, na Central de Vendas, nas lives e na
  reputação: dá para comparar avaliações e produtos sem saber quem é. O fornecedor continua vendo
  só "Vendedor verificado". O nome real fica para a própria organização e para a equipe, e a
  busca do catálogo não procura mais pelo nome real. Feito no banco (as RPCs não devolvem o nome),
  não só na tela.
- **Fornecedor**: sem "Academia" e sem "Indique e ganhe" (menu, rotas e campo de código no
  cadastro).
- **Status do sistema**: só a equipe (menu, início, rodapés da landing e do login). Antes de
  configurar o Supabase continua aberto para o diagnóstico.

### Removido

- **Shopify e WooCommerce**: conexão manual por webhook, segredos, credenciais de API, envio de
  estoque e as Edge Functions `webhooks`, `credentials` e `listings`. Os canais agora são só
  **Mercado Livre, Shopee e TikTok Shop** (o banco recusa os demais).
- **Gerenciador de anúncios** ("Anúncios"), que só publicava em Shopify/WooCommerce. A
  configuração por canal volta na Fase 34, dentro do cadastro do produto.

### Testes

- Testes de banco migrados para uma conexão real do Mercado Livre (OAuth); testes de apelido do
  fornecedor e dos canais permitidos.

## [0.32.0] — Fase 32: Envio automático ao fornecedor com etiqueta e nota fiscal (Mercado Livre)

### Adicionado

- **Pedido pago do Mercado Livre vai direto ao fornecedor**: é confirmado sozinho e vira pedido de
  fornecimento (mesma regra da confirmação manual), e o fornecedor recebe o aviso. Ligado por
  padrão; o vendedor desliga por conexão em Integrações. Sem estoque ou com o fornecedor
  indisponível, o pedido fica pendente, o motivo vai para o log da conexão e o vendedor é avisado.
- **Etiqueta e nota fiscal do Mercado Livre anexadas ao envio do fornecedor**: a etiqueta (PDF da
  API oficial, quando o envio fica pronto para impressão, com o rastreio) e a nota fiscal emitida
  pelo **Faturador do Mercado Livre** (DANFE em PDF e XML, quando autorizada). Chegam pelas
  notificações de pedido e de envio (`shipments`); sem duplicar, com aviso ao fornecedor. Pedido
  com estoque próprio ou mais de um fornecedor: os documentos ficam no pedido para o vendedor
  repassar.
- **Botão "Buscar etiqueta e nota no Mercado Livre"** no pedido (limite de 20 buscas a cada 10
  minutos por pessoa).
- **Upload manual de nota fiscal** (DANFE em PDF ou XML) além da etiqueta, para quem emite a nota
  fora do Mercado Livre.
- **Testes**: 7 de banco, 4 do módulo do Mercado Livre e 3 de frontend.

### Para ativar

- No app do Mercado Livre, assinar também o tópico **shipments** (além de `orders_v2`).

### Limitações conhecidas

- **Não exercitado contra contas reais** (só respostas simuladas): valide com usuários de teste.
- Nota emitida em outro sistema e enviada ao Mercado Livre não é baixada de lá: anexe manualmente.

## [0.31.0] — Fase 31: Mercado Livre (pedidos e estoque)

### Adicionado

- **Conexão por OAuth 2.0 com PKCE** (Edge Function `mercadolivre`): o vendedor autoriza no próprio
  Mercado Livre e volta conectado. Estado e `code_verifier` ficam no banco sem acesso pela API e
  valem 10 minutos; tokens ficam cifrados (mesma chave das credenciais). Uma conta do Mercado Livre
  fica ligada a uma loja por vez.
- **Renovação de token** automática (antes de vencer), com gravação por versão: duas renovações ao
  mesmo tempo não se atropelam (o token de renovação do Mercado Livre é de uso único).
- **Pedidos pelas notificações** (`orders_v2`): cada notificação é validada pelo id do app e o
  pedido é **relido na API** com o token do vendedor, junto com o envio. Pagos entram pela mesma
  ingestão dos outros canais; **Full**, retirada/a combinar, cancelados e aguardando pagamento são
  ignorados.
- **Estoque**: a fila de envio passa a atualizar o Mercado Livre (anúncio ou variação achados pelo
  SKU do vendedor). O **vínculo manual de SKU agora aceita produto importado do fornecedor**
  (anuncia o estoque dele) — vale para todos os canais.
- **Telas**: "Conectar Mercado Livre" em Integrações, avisos da volta do OAuth e painel da conexão
  (como funciona, reconectar).
- **Testes**: 4 de banco, 9 do módulo do Mercado Livre e 3 de frontend.

### Para ativar

- Criar o app em developers.mercadolivre.com.br com a URL de retorno
  `<SUPABASE_URL>/functions/v1/mercadolivre/callback`, notificações em
  `<SUPABASE_URL>/functions/v1/mercadolivre/notifications` (tópico **orders_v2**), e cadastrar os
  segredos `MERCADOLIVRE_CLIENT_ID`, `MERCADOLIVRE_CLIENT_SECRET` e `APP_URL` (além da
  `CREDENTIALS_ENCRYPTION_KEY`). Sem eles a tela mostra "não configurado".

### Limitações conhecidas

- **Não exercitado contra contas reais** (só respostas simuladas): valide com usuários de teste do
  Mercado Livre antes de produção.
- Publicar anúncio no Mercado Livre pela TheSigns ainda não (categoria e atributos obrigatórios).
- Mensagens, perguntas e reclamações do Mercado Livre não são trazidas.

## [0.30.0] — Fase 30: Etiquetas de envio

### Adicionado

- **Banco** (`supabase/migrations/20261006120000_shipping_labels.sql`):
  - **Etiqueta anexada ao envio** (PDF, PNG ou JPG até 5 MB) no bucket privado `shipping-labels`,
    vinculada a um pedido de fornecimento ou a um pedido de estoque próprio. Pasta por envio; só
    quem participa (fornecedor e vendedor daquele fornecimento, ou o vendedor do pedido) lê e envia.
  - Caso principal: o vendedor anexa a **etiqueta gerada pelo marketplace** e o fornecedor baixa,
    imprime e envia — o rastreio da etiqueta já preenche o formulário de envio dele.
  - Anular etiqueta errada; envio cancelado ou entregue não recebe etiqueta; o outro lado é avisado.
- **Telas**: seção de etiquetas no pedido (por fornecimento e para os itens do estoque próprio) e no
  fornecimento; selo **"Em trânsito"** no pedido enviado ou com fornecimento enviado com rastreio.
- **Testes**: 4 de banco e 7 de frontend.

### Decisões

- **Geração de etiqueta pela API oficial** (Melhor Envio, Correios com contrato) **não foi feita**:
  depende de contrato e credenciais da plataforma. Sem isso, o fluxo é o upload — nada de etiqueta
  simulada. Mesmo motivo para o "em trânsito" automático por evento da transportadora: hoje ele é
  derivado do envio com rastreio.

## [0.29.0] — Fase 29: Gerenciador de anúncios e publicação

### Adicionado

- **Banco** (`supabase/migrations/20261005120000_channel_listings.sql`):
  - **Anúncio no canal**: produto do vendedor numa conexão Shopify ou WooCommerce, com título,
    descrição e preço próprios. Criar, editar, **duplicar** para outra loja, apagar rascunho.
  - **Publicar, pausar e reativar** com **etapas reais** gravadas na hora (conferência dos dados,
    credenciais, produto no marketplace, preço e estoque, vínculo dos SKUs, conclusão) — o histórico
    fica como **log de sincronização**, junto com os eventos da integração.
  - Publicar **vincula cada SKU**: pedidos do marketplace entram sozinhos e o estoque sincroniza.
    SKU já vinculado a outro item é apontado, não sobrescrito.
  - **Dropshipping**: anúncio de produto importado envia o **estoque do fornecedor**; mudanças no
    estoque dele entram na fila de envio.
  - Uma ação por vez por anúncio; atualizar um anúncio pausado mantém pausado.
- **Edge Function `listings`** (JWT de quem pediu): Shopify Admin GraphQL (`productSet` com opções,
  variações, SKU, preço e fotos; `inventorySetQuantities` no local configurado; `productUpdate`
  para pausar) e WooCommerce REST v3 (produto simples ou variável, variações em lote casadas pelo
  SKU, status `draft`/`publish`). Credenciais decifradas só em memória.
- **Telas**: **Anúncios** (novo rascunho, lista por situação) e página do anúncio (conteúdo,
  publicar/enviar alterações, pausar/reativar, andamento etapa a etapa, histórico, duplicar).
- **Testes**: 6 de banco, 8 do módulo de publicação (respostas simuladas) e 4 de frontend.

### Limitações conhecidas

- **As chamadas às APIs não foram exercitadas contra lojas reais** (só respostas simuladas): valide
  numa loja de desenvolvimento Shopify/WooCommerce antes de usar em produção.
- Fotos vão só na criação do anúncio; trocar fotos depois ainda não é enviado.
- Remover o anúncio do marketplace não é feito daqui (pause no lugar).
- Produto do fornecedor que sai do catálogo não zera o estoque anunciado automaticamente (o
  vendedor é avisado pela notificação e deve pausar).
- Mercado Livre, Shopee, TikTok Shop e Amazon seguem nas fases 31–34.

## [0.28.0] — Fase 28: Avaliações e reputação

### Adicionado

- **Banco** (`supabase/migrations/20261004120000_reviews.sql`):
  - **Só avalia quem comprou/recebeu**: o comprador do checkout avalia a loja pelo link de
    acompanhamento depois do envio; o vendedor avalia o fornecedor por pedido de fornecimento
    enviado. Uma avaliação por pedido, 1–5 estrelas e comentário opcional.
  - Aparece só o primeiro nome do comprador ou "Vendedor verificado" — nada de e-mail ou documento.
  - A organização avaliada **responde uma vez**; a equipe **oculta** com motivo (sai da média,
    auditado). Tabela sem leitura direta: tudo por RPCs que já filtram as ocultas.
  - **Métricas objetivas** (90 dias, a partir de 5 pedidos): fornecedor — pedidos enviados,
    cancelamentos e tempo médio até o envio; vendedor — vendas pagas entregues, enviadas e canceladas.
  - Aviso de nova avaliação na central de notificações.
- **Edge Function `checkout`**: `POST /review` (limite por IP) e nota da loja na página do produto
  e na vitrine.
- **Telas**:
  - Comprador: "Avalie sua compra" no acompanhamento do pedido; nota da loja no checkout e na vitrine.
  - Vendedor: "Avaliar fornecedor" no pedido; **reputação do fornecedor** no anúncio do catálogo.
  - Vendedor e fornecedor: **Reputação** (nota, distribuição, métricas, avaliações e resposta).
  - Equipe: **Avaliações** (todas, 1–2 estrelas, ocultas; ocultar/reexibir).
- **Testes**: 7 de banco e 8 de frontend/parser.

### Limitações conhecidas

- Vitrine de vendedor não é visível a outras contas conectadas (só o público vê a nota na vitrine).
- Pedidos de marketplace não geram avaliação aqui (cada marketplace tem a sua).

## [0.27.0] — Fase 27: Suporte e denúncias

### Adicionado

- **Banco** (`supabase/migrations/20261003120000_support.sql`):
  - **Chamados** por categoria (pedido/entrega, pagamento/carteira/saque, produto/catálogo, conta,
    denúncia, outro), com **conversa** pessoa ↔ equipe. Mensagens imutáveis.
  - Pode anexar um **pedido** da organização e, nas **denúncias**, o anúncio do catálogo ou o código
    público da loja/fornecedor denunciado (obrigatório ter alvo).
  - Estados: com a equipe → respondido (vez da pessoa) → encerrado; responder reabre.
  - Quem abriu vê os seus; a equipe (com MFA) vê todos. Escrita só por RPC.
  - Avisos na central de notificações: equipe recebe chamados, denúncias e respostas; a pessoa
    recebe respostas e encerramento.
  - Limites: 10 chamados por dia e 60 mensagens por hora por pessoa.
- **Telas**:
  - **Suporte** (`/suporte`): abrir chamado, meus chamados e conversa.
  - Atalhos: "Pedir ajuda com este pedido" (pedido e fornecimento) e "Denunciar anúncio"
    (catálogo), que já preenchem o chamado.
  - Equipe: **Suporte e denúncias** (resumo, fila por estado e categoria, conversa com o contexto:
    pessoa, organização, pedido, denunciado e se está suspenso).
- **Testes**: 7 de banco e 5 de frontend.

### Limitações conhecidas

- Sem anexos (fotos/arquivos) nas mensagens.
- Comprador sem conta (checkout) ainda não abre chamado nem denuncia pela vitrine.
- Sem atribuição de chamado a uma pessoa específica da equipe.

## [0.26.0] — Fase 26: Rate limiting, endurecimento e MFA da equipe

### Adicionado

- **Rate limiting** (`supabase/migrations/20261002120000_hardening.sql`): contador em janela fixa no
  schema `private` (fora da API).
  - Por gatilho nas escritas que dá para repetir em massa: convites (50/h por organização), saques
    (10/dia por organização), links de divulgação (50/h por loja), perguntas na Academia (20/h por
    pessoa), produtos (1000/h por organização). Estourou → erro `rate_limited` com mensagem na tela.
  - **Por IP** nas rotas públicas do checkout (Edge Function): pagamento 10 a cada 10 min, visitas
    120/h, leituras (oferta, vitrine, link) 300 a cada 10 min. Só o hash do IP é guardado. Se o
    contador falhar, a venda segue (o limite não derruba o checkout).
- **MFA obrigatório para a equipe**: toda RPC e policy da administração
  (`private.is_platform_admin()`) passa a exigir sessão **aal2** (senha + código TOTP do Supabase
  Auth).
  - **Minha conta → Verificação em duas etapas**: ativar com QR Code/chave e código, ver e remover
    aplicativos (qualquer conta pode ativar; a equipe não pode remover o último).
  - **Login em dois passos** (`/verificacao`): quem tem o segundo fator ativo e entrou só com a
    senha precisa do código antes de usar o app.
  - Equipe sem segundo fator: a área de administração mostra o cadastro no lugar do painel, e o
    Início avisa.
- `supabase/config.toml`: TOTP habilitado no ambiente local.
- **Testes**: 5 de banco, 3 do módulo de limite por IP e 6 de frontend. Simulador de banco agora
  tem `auth.jwt()` e sessões aal1/aal2.

### Atenção ao atualizar

- **Contas da equipe perdem acesso à administração até ativarem a verificação em duas etapas** em
  Minha conta (leva um minuto: QR Code no aplicativo autenticador + código).
- TOTP vem ativado nos projetos hospedados do Supabase; se o cadastro disser que está desativado,
  ative em Authentication → Multi-Factor no painel.

### Limitações conhecidas

- Sem CSP/cabeçalhos de segurança: dependem de onde o frontend for hospedado (fica para o deploy).
- CORS das Edge Functions segue aberto (`*`): não usam cookies, a autorização é por token.
- Sem CAPTCHA no cadastro.

## [0.25.0] — Fase 25: Landing page

### Adicionado

- **Landing page** em `/` para visitantes (quem já entrou continua indo para o Início do app):
  headline, como funciona (4 etapas), vendedores, fornecedores, Academia, planos, dúvidas
  frequentes e chamada final. Textos em `src/pages/landing/content.ts`.
- Só descreve o que o sistema faz hoje: **sem depoimentos, números de clientes ou preços
  inventados**. Integrações ainda não entregues (Mercado Livre, Shopee, TikTok Shop) e planos pagos
  aparecem como "em preparação" / "ainda não existem".
- "Sou fornecedor" abre o cadastro com o tipo fornecedor marcado (`/cadastro?conta=fornecedor`).
- Descrição da página (`meta description`) e título próprios.
- **Testes**: 3 de frontend (landing para visitante, app para quem entrou, nada inventado).

### Alterado

- Visitante em `/` vê a landing em vez de ser mandado para `/entrar`.

## [0.24.0] — Fase 24: Notificações em tempo real e alertas

### Adicionado

- **Banco** (`supabase/migrations/20261001120000_notifications.sql`):
  - Tabela `notifications` (uma linha por destinatário), publicada no **Supabase Realtime**. Cada
    pessoa só lê e marca as suas; notificação de organização some para quem saiu dela. Guardadas
    por 90 dias.
  - Todas nascem de gatilhos em fatos reais do banco:
    - **Estoque**: baixo (disponível ≤ mínimo do item, a regra das Análises) e esgotado para o dono
      do estoque; baixo, esgotado e de volta para quem revende o produto do fornecedor. Dispara na
      passagem do limite, não a cada movimento.
    - **Catálogo**: preço de atacado alterado (owner/admin de quem revende, com valores), produto
      indisponível/disponível de novo (anúncio despublicado, produto arquivado, fornecedor suspenso
      ou fora de análise), resultado da moderação para o fornecedor.
    - **Pedidos**: novo pedido de fornecimento e cancelamento (fornecedor), envio do fornecedor
      (vendedor), novo pedido de marketplace.
    - **Dinheiro** (só owner/admin): venda paga e estorno do checkout, saque aprovado/pago/recusado,
      nova indicação e recompensa de indicação.
    - **Equipe**: fornecedor aguardando análise, saque solicitado, estorno pendente.
  - `mark_notifications_read` e `mark_all_notifications_read`.
- **Telas**: sino no cabeçalho com contador de não lidas, últimas 10, "marcar todas como lidas" e
  atualização em tempo real; página **Notificações** (todas / não lidas, carregar mais). Com mais de
  uma organização, cada notificação mostra de qual é.
- **Testes**: 9 de banco e 5 de frontend. Linha de base de RLS atualizada.

### Limitações conhecidas

- Só dentro do app: sem e-mail, push ou WhatsApp.
- Sem preferências por tipo (não dá para silenciar um tipo de aviso).
- O Realtime não foi exercitado nos testes locais (sem servidor Realtime); o contador também
  recarrega a cada 5 minutos como garantia.

## [0.23.0] — Fase 23: Afiliados e indicação

### Adicionado

- **Banco** (`supabase/migrations/20260930120000_affiliates.sql`):
  - **Código público** de cada organização (gerado; o proprietário pode trocar): endereço da
    vitrine e código de indicação.
  - **Links de divulgação** do vendedor (`/r/<código>`) para um produto do checkout ou para a
    vitrine. Código próprio ou gerado; nome editável e pausa (código e destino fixos para não
    misturar estatísticas).
  - **Cliques e visitas**: cada acesso soma um clique; visita = navegador diferente por dia (só o
    hash do id aleatório do navegador vai para o banco).
  - **Vendas atribuídas pelo checkout**: o pedido guarda o link (ou a vitrine) por onde o comprador
    chegou, dentro de 30 dias. Só vale link ativo da própria loja.
  - **Desempenho** por origem (vitrine, cada link e acesso direto ao produto): cliques, visitas,
    pedidos, vendas pagas (sem estornos), valor, comissão e conversão, em 7/30/90 dias.
  - **Indique e ganhe**: a organização nova informa o código de quem a indicou (no cadastro, pelo
    link `/cadastro?indicacao=<código>`, ou em até 30 dias antes da primeira venda). Na primeira
    venda paga pelo checkout da indicada (como vendedora ou fornecedora), dentro do prazo e acima
    da venda mínima, quem indicou ganha a recompensa, paga da receita da TheSigns e liberada na
    carteira junto com essa venda. Estorno da venda desfaz a recompensa. Recompensa, venda mínima e
    prazo são da equipe, ficam congelados em cada indicação e o programa **nasce desligado**.
  - Carteira passa a considerar a recompensa de indicação; Financeiro ganha o tipo "Recompensa de
    indicação".
- **Edge Function `checkout`**: `GET /store/<código>` (vitrine com fotos assinadas),
  `GET /link/<código>` (destino do link), `POST /visit` (conta o acesso) e origem do comprador no
  `POST /pay`. Origem inválida é descartada, nunca impede a compra.
- **Telas**:
  - Público: **vitrine** `/loja/<código>` e redirecionamento `/r/<código>`.
  - Vendedor: **Links e divulgação** (link e QR Code da loja, troca do endereço, novos links,
    desempenho, QR Code por link com download em PNG).
  - Vendedor e fornecedor: **Indique e ganhe** (link/código/QR de indicação, indicações e situação,
    informar quem indicou). Criação de organização aceita o código de indicação.
  - Equipe: **Indicações** (regras do programa, resumo e lista).
- **Testes**: 11 de banco, 7 do módulo de afiliados da Edge Function e 10 de frontend. Linha de base
  de RLS atualizada.

### Limitações conhecidas

- Visitas podem ser infladas com ids de visitante falsos; o rate limit por IP chega na Fase 26.
- A atribuição usa o armazenamento do navegador: outro aparelho ou navegador anônimo conta como
  acesso direto.
- Indicação combinada entre pessoas diferentes não é detectável automaticamente; a equipe deve
  manter a recompensa abaixo da margem da TheSigns na venda mínima.
- Vendas de marketplace não entram em atribuição nem em indicação (só o checkout próprio).

## [0.22.0] — Fase 22: Carteira e saques

### Adicionado

- **Banco** (`supabase/migrations/20260929120000_wallet.sql`):
  - **Carteira** calculada do livro-razão com o dinheiro que passou pela plataforma (checkout):
    **disponível**, **pendente** (prazo de garantia) e **bloqueado** (saques em andamento).
    Recebimentos manuais continuam só no Financeiro.
  - Cada venda libera no que vier primeiro: **entrega + 7 dias** ou **envio do fornecedor + 30 dias**.
    Os dois prazos e o **saque mínimo (R$ 10,00)** são editáveis pela equipe (`wallet_settings`).
  - Estorno/contestação antes da liberação se compensa no próprio pedido; depois dela, reduz o
    disponível (pode ficar negativo até novas vendas cobrirem).
  - **Saque por PIX**: o proprietário solicita (chave CPF/CNPJ/e-mail/celular/aleatória validada,
    titular com CPF/CNPJ), pode cancelar enquanto solicitado; a equipe **aprova** (confere o saldo de
    novo), **recusa** com motivo ou **registra o pagamento** com o identificador da transferência
    no Mercado Pago, e só então o débito `withdrawal` entra no razão. Tudo auditado.
- **Telas**:
  - Vendedor e fornecedor: **Carteira** (saldos, regra de liberação, solicitar/cancelar saque,
    histórico, vendas em garantia com a data de liberação).
  - Equipe: **Saques** (resumo, fila de abertas com dados para copiar, aprovar/recusar/registrar
    pagamento, regras da carteira).
  - Financeiro: novo tipo de lançamento "Saque".
- **Testes**: 12 de banco e 8 de frontend. Linha de base de RLS atualizada.

### Limitações conhecidas

- O PIX é feito pela equipe no painel do Mercado Pago e registrado aqui: o repasse automático pela
  API depende de liberação da conta (Money Out) e fica para depois.
- A entrega é marcada pelo vendedor; o prazo após a entrega é a proteção contra liberação antecipada.
- Pedidos de marketplace (dinheiro direto na conta do vendedor) continuam fora da carteira; a
  cobrança da parte da TheSigns nesses pedidos segue em aberto (ROADMAP, ponto 3).

## [0.21.0] — Fase 21: Checkout próprio + Mercado Pago

### Adicionado

- **Banco** (`supabase/migrations/20260928120000_checkout.sql`):
  - O vendedor liga o **checkout** num produto importado do catálogo (`set_product_checkout`) e
    divulga o link `/c/<produto>`. Preço = preço do produto do vendedor; preço que não cobre
    fornecedor + comissão é recusado.
  - **Pedido do checkout** (`orders.channel = checkout`): nasce aguardando pagamento, sem reserva.
    Pagamento **aprovado** confirma sozinho (reserva no fornecedor e pedido de fornecimento) e lança
    a **divisão**: comissão do vendedor e atacado do fornecedor no livro-razão de cada um, receita da
    TheSigns num livro-razão próprio (`platform_ledger_entries`), com a **taxa real do Mercado Pago**.
    Comissão e regra de origem ficam **congeladas** no pedido (`order_splits`).
  - Aprovado **sem estoque** (ou com valor divergente) → pedido cancelado e **estorno automático**.
    PIX/boleto vencido ou cartão recusado → cancela. **Estorno/contestação** desfaz a divisão; se o
    fornecedor já enviou, ele fica com o atacado e a perda é da plataforma.
  - Vendedor não confirma, cancela nem registra pagamento de pedido do checkout; o fornecedor recebe
    pela plataforma (o vendedor não paga o atacado). Pedidos de marketplace ganham o canal
    `marketplace`.
  - Equipe: resumo (vendas, taxas, fornecedores, comissões, receita), lista de pagamentos e
    **estorno** auditado (antes do envio do fornecedor).
- **Edge Function `checkout`**: oferta pública (fotos com URL assinada), pagamento pela API v1 do
  Mercado Pago (PIX 30 min, boleto 3 dias, cartão até 12x), webhook com verificação da assinatura
  `x-signature` e releitura do pagamento na API, estorno. Tudo idempotente.
- **Telas**:
  - Comprador (sem conta): página do produto com opção, quantidade, dados de entrega e **Payment
    Brick** (PIX, cartão, boleto); acompanhamento com QR Code/copia-e-cola do PIX, link do boleto,
    atualização automática e rastreio.
  - Vendedor: seção **Checkout próprio** no produto importado (comissão prevista, link, ligar/desligar);
    selo **Checkout** e "Aguardando pagamento" nos pedidos; pagamento e comissão no pedido.
  - Equipe: **Pagamentos** (resumo, filtros, estorno).
- **Testes**: 18 de banco, 14 do módulo do Mercado Pago e 10 de frontend. Linha de base de RLS
  atualizada (`checkout_order_status` é a única função liberada para `anon`).

### Limitações conhecidas

- A Edge Function não foi executada aqui (sem Deno nem credenciais): validação, corpo do pagamento,
  leitura da resposta e assinatura estão testados; valide com as **credenciais de teste** do Mercado
  Pago antes de produção.
- Sem os segredos `MERCADOPAGO_*` o checkout mostra "Pagamentos ainda não configurados".
- Um produto por pedido, até 10 unidades, frete incluso no preço (cotação de frete fica para a Fase 30).
- Estorno parcial não é tratado (só total). Na contestação/estorno, a devolução da taxa do Mercado
  Pago não é conciliada.
- Pedido do checkout aguardando pagamento conta como pendente nas análises (igual aos pedidos
  manuais pendentes) até vencer.
- Se a notificação se perder, o pedido fica pendente até a próxima notificação do Mercado Pago (não
  há conciliação periódica ainda).
- Disponível/pendente/saque dos valores lançados: Fase 22.

## [0.20.0] — Fase 20: Ferramentas

### Adicionado

- **Banco** (`supabase/migrations/20260927120000_tools.sql`):
  - `pricing_simulate`: lucro e margem de uma venda unitária a um preço, com a taxa do marketplace
    da Fase 15 (mesma regra, categoria e faixa de preço), impostos, antecipação, custo e frete pago
    pelo vendedor. Impostos e antecipação são informados por quem usa (nada fixo no código).
  - `pricing_target`: **menor preço** que atinge a margem desejada. Testa cada regra/faixa e só
    aceita o preço se a regra que vale nele for a usada na conta (ex.: TikTok abaixo e acima de
    R$ 50). Margem impossível → `pricing.unreachable`.
  - `ai_begin_generation` (owner/admin, produto da própria organização): reserva para os geradores
    de **títulos**, **copy para redes sociais**, **roteiro de vídeo** e **roteiro de live**, com
    orientação opcional de até 300 caracteres. **Mesma cota diária** das descrições; a reserva foi
    extraída para `private.ai_reserve` e `ai_begin_description` passou a usá-la.
- **Edge Function `ai`**: aceita `kind` e `brief`. Os geradores pedem a resposta em **JSON**
  (`output_config.format`, lista de opções), validam e limpam cada opção (tamanho, duplicadas,
  markdown) e usam o **fallback do servidor** da API do Claude quando o modelo principal recusa por
  política. A descrição de produto continua igual.
- **Tela Ferramentas** (vendedor): **Preço ideal**, **Simulador de lucro** (marketplace, tipo de
  anúncio e categoria só com taxa ativa; custo preenchido a partir de um produto; detalhamento do
  preço ao lucro; impostos e antecipação lembrados no navegador) e **Textos com IA** (tipo,
  produto, orientação, cota restante, opções com copiar; nada é salvo).
- **Testes**: 12 de banco e 13 de frontend.

### Limitações conhecidas

- A Edge Function não foi executada aqui (sem Deno, Supabase CLI nem chave de API): prompts,
  esquema e limpeza estão testados; rode `supabase functions serve ai` antes de produção.
- As contas usam o modelo atual (o vendedor recebe a venda e paga o custo). A divisão com a
  TheSigns entra quando o checkout próprio existir (Fase 21).
- Uma unidade por cálculo; taxas de campanha do marketplace não entram (use o simulador da
  Fase 15 no anúncio do catálogo para isso).
- Os geradores trabalham com produtos da própria organização (importe do catálogo antes).

## [0.19.0] — Fase 19: Central de Vendas e campanhas para lives

### Adicionado

- **Banco** (`supabase/migrations/20260926120000_sales_center.sql`):
  - `sales_materials`: materiais de divulgação por anúncio do catálogo — **vídeo** e **imagem**
    (bucket privado `sales-materials`, até 100 MB, pasta do anúncio) e textos prontos (**roteiro,
    título, hashtags, argumento**). Só owner/admin do fornecedor dono do anúncio escreve (FK
    composta com a organização); a equipe pode excluir. Até 50 por anúncio.
  - Vendedores leem materiais e arquivos **só de anúncio visível** (publicado, aprovado, fornecedor
    aprovado e ativo).
  - `listing_favorites`: favoritos por usuário, só de conta vendedora e anúncio visível.
  - `sales_center`: vitrine com abas **em alta** (unidades em pedidos de fornecimento não
    cancelados dos últimos 30 dias), **maior margem** (atacado × preço sugerido), **novidades** e
    **favoritos**, com busca. `sales_center_listing`: materiais e campanhas abertas do produto.
  - **Campanhas para lives** (`live_campaigns`, produtos e participantes; sem acesso direto): a
    equipe cria/edita por `admin_save_live_campaign` (auditado), com período (até 90 dias),
    marketplace opcional, comissão própria e situação (rascunho/publicada/cancelada). O vendedor
    (owner/admin) entra ou sai por `set_live_campaign_participation` até o fim da campanha.
  - **Comissão por campanha**: enquanto a campanha publicada está no ar, a loja participante recebe
    a comissão dela nos produtos incluídos (e no marketplace da campanha, se houver). Precedência
    sobre produto/vendedor/categoria/padrão; se houver mais de uma, a maior. A divisão da venda
    (`estimate_sale_split`) já mostra a origem "campanha de live".
- **Telas**:
  - Vendedor: **Central de Vendas** (abas, busca, favoritar, selo "em campanha", vendidos em 30
    dias, margem, estoque e nº de materiais), página do produto com materiais agrupados por tipo
    (**copiar** textos, **baixar** vídeos e imagens, prévia), campanhas do produto e atalho para
    importar e calcular. **Campanhas para lives** (lista e detalhe com participar/sair).
  - Fornecedor: seção **Materiais de divulgação** no produto com anúncio (enviar, ver, excluir).
  - Equipe: **Campanhas de live** (lista, criação/edição com busca de produtos, participantes).
  - Atalho da Central no Início do vendedor.
- **Testes**: 10 de banco e 9 de frontend.

### Limitações conhecidas

- "Em alta" mostra unidades somadas de todos os lojistas (sem identificar quem vendeu). Pedidos de
  marketplace que não passam por fornecedor da plataforma não entram na conta.
- Materiais não passam por moderação prévia: a equipe remove depois, se preciso. Não há contagem
  de downloads.
- A comissão da campanha vale para qualquer venda da loja participante no período e canal da
  campanha — não só para vendas feitas durante a transmissão. Ela só vira dinheiro quando a divisão
  for congelada no pedido (checkout, Fase 21).
- Participação em campanha e novidades não geram notificação (Fase 24).

## [0.18.0] — Fase 18: Onboarding e painel do vendedor

### Adicionado

- **Banco** (`supabase/migrations/20260925120000_seller_dashboard.sql`):
  - Perfil com **telefone** e **CPF/CNPJ** (só dígitos, com dígitos verificadores checados no
    banco). O cadastro envia os dois; valor inválido é descartado sem impedir a criação da conta.
  - `seller_onboarding`: checklist **calculado de dados reais** — cadastro completo, produto
    cadastrado, produto ativo, canal conectado, primeira venda e (quando há curso liberado) uma aula
    da Academia concluída.
  - `seller_dashboard`: quanto vendi, lucro bruto e recebido no período; a receber dos clientes e a
    pagar aos fornecedores (situação atual). Só owner/admin.
  - `analytics_series` (dia, semana ou mês; vendedor e fornecedor) e `analytics_channels` (pedido
    manual ou canal conectado).
  - `seller_suggestions` ("o que vender"): anúncios aprovados, com estoque e preço sugerido acima
    do atacado, ainda não importados, pela margem sugerida pelo fornecedor.
- **Telas**:
  - Cadastro pede telefone e CPF/CNPJ; **Minha conta** permite completar/editar.
  - **Início do vendedor** vira painel: primeiros passos com o próximo passo em destaque (some
    quando tudo está feito), cartões de valores com período, gráfico por dia/semana/mês, vendas por
    canal e "o que vender". Membros veem os passos e as sugestões, sem valores.
  - `ProgressBar` passou para `components/ui` (compartilhado com a Academia).
- **Testes**: 16 de banco e 11 de frontend.

### Limitações conhecidas

- "Quanto ganhei" é o **lucro bruto** (produtos − custo): taxas de marketplace não são descontadas,
  porque o pedido ainda não guarda tipo de anúncio nem divisão congelada (chega com o checkout, Fase
  21).
- "O que vender" usa a margem sugerida pelo fornecedor; "em alta" (vendas na plataforma) fica para a
  Central de Vendas (Fase 19).
- CPF/CNPJ não é único entre contas e pode ser trocado pelo usuário; travar/verificar o documento
  fica para os saques (Fase 22).
- Contas antigas não têm telefone/documento até completarem em Minha conta (o checklist avisa).
- O fornecedor ainda não tem checklist próprio; a série por semana/mês já funciona para ele no banco.

## [0.17.0] — Fase 17: Academia

### Adicionado

- **Banco** (`supabase/migrations/20260924130000_academy.sql`):
  - Cursos (nível, público: todos/vendedores/fornecedores, rascunho/liberado/bloqueado, capa,
    certificado), módulos e aulas com **vídeo do YouTube** (só o id de 11 caracteres), duração,
    aula obrigatória/opcional e **botão de ação** que leva a uma tela do app. Materiais: arquivo
    (PDF/imagem, bucket privado `academy`) ou link https.
  - Regras de liberação checadas no banco: livre, após a aula anterior, após o módulo anterior ou
    por aprovação da equipe (com pedido do aluno).
  - Alunos **não leem as tabelas**: RPCs `academy_catalog`, `academy_course` (esboço sem ids de
    vídeo), `academy_lesson` (só aula liberada), progresso (`academy_save_progress` guarda posição e
    maior %, conclui aos 90%; `academy_set_completed`), certificado (`academy_claim_certificate`,
    `academy_certificate`) e perguntas (`academy_ask`, `academy_lesson_questions` mostra só o
    primeiro nome de outros alunos; 20 por dia).
  - Equipe: conteúdo direto nas tabelas (policy só para ela), ordenação, alunos com progresso,
    pedidos de liberação, emissão manual de certificado (auditada) e respostas às perguntas.
  - Arquivos: aluno lê a capa de curso visível e o material de aula liberada.
- **Telas**:
  - Aluno: **Academia** (cursos com progresso), página do curso (% concluído, módulos x/y, aulas x/y,
    "Continuar de onde parou", pedido de liberação, certificado), **aula** com player oficial do
    YouTube (velocidade, recomeçar, retoma a posição, salva a cada 15 s e ao pausar/sair), concluir,
    anterior/próxima, lista de aulas, descrição, materiais, perguntas e o botão de ação.
    **Certificado** para imprimir ou salvar em PDF.
  - Equipe: **Academia** (cursos, liberações, perguntas) e editor do curso (dados, capa, módulos,
    aulas com link do YouTube, materiais, ordenação, alunos, certificado).
- **Testes**: 11 de banco e 10 de frontend.

### Limitações conhecidas

- A duração da aula é informada pela equipe (ler do YouTube exigiria chave da API de dados).
- O player do YouTube não foi exercitado num navegador real aqui; se o script não carregar, a aula
  mostra o link para assistir no YouTube e o botão de concluir.
- "Assistiu 90%" usa a posição do player: pular para o fim conta como assistido.
- Liberação por plano chega com os planos. Sem verificação pública do código do certificado.
- Tarefas/exercícios, comunidade e aulas ao vivo ficam para fases próprias.

## [0.16.0] — Fase 16: Moderação de fornecedores e anúncios

### Adicionado

- **Banco** (`supabase/migrations/20260924120000_moderation.sql`):
  - Fornecedor novo nasce **em análise** (`organizations.approval_status`); a equipe aprova ou
    reprova com motivo. O proprietário de um fornecedor reprovado pede nova análise.
  - Anúncio novo nasce **em análise** (`catalog_listings.moderation_status`). A equipe aprova,
    reprova (o fornecedor corrige e reenvia) ou bloqueia (só a equipe desfaz). Motivo obrigatório
    para reprovar/bloquear; o fornecedor vê o motivo.
  - Vendedores só veem anúncio **publicado + produto ativo + anúncio aprovado + fornecedor aprovado
    e não suspenso**: vale para busca, detalhe, importação, imagens, calculadora e roteamento de
    pedidos. Colunas de moderação não têm grant de escrita para o cliente.
  - Equipe: filas `admin_supplier_reviews` (com contato do responsável) e `admin_moderation_listings`
    (com imagens), `admin_review_supplier`, `admin_moderate_listing` e
    `admin_update_listing_content` (corrige nome, descrição e categoria). Tudo auditado.
  - A equipe lê as imagens de produtos com anúncio no catálogo (para moderar).
  - `admin_stats` informa fornecedores e anúncios aguardando análise.
- **Telas**:
  - Equipe: **Moderação** (anúncios com fotos, dados e ações; fornecedores), atalho com as filas
    pendentes na Administração.
  - Fornecedor: aviso de cadastro em análise/reprovado (com pedido de nova análise) e situação da
    análise de cada anúncio, com reenvio.
- **Testes**: 10 de banco e 6 de frontend. Os testes de fases anteriores aprovam o catálogo com
  `approveCatalog` (helper de teste).

### Limitações conhecidas

- Fornecedores e anúncios que já existiam antes desta fase ficaram **aprovados** automaticamente.
- Alterar o produto depois da aprovação (nome, fotos, descrição) **não** reenvia para análise.
- Produtos já importados por vendedores continuam no catálogo deles quando o anúncio é bloqueado;
  o bloqueio impede novas importações e o encaminhamento de novos pedidos ao fornecedor.
- Decisões não são avisadas por e-mail ou notificação (fase de notificações).

## [0.15.0] — Fase 15: Taxas de marketplace, comissão do vendedor e divisão da venda

### Adicionado

- **Banco** (`supabase/migrations/20260923180000_fees_commissions.sql`):
  - `marketplace_fee_rules`: taxa por marketplace, tipo de anúncio, categoria (ou categoria-mãe),
    faixa de preço unitário e campanha (campanha soma à base); percentual + custo fixo por item.
    Nenhuma taxa no código. Faixas ativas sobrepostas são recusadas.
  - `commission_rules`: comissão do vendedor (padrão **15%**) com exceções por produto, vendedor,
    subcategoria e categoria-mãe, nessa ordem de precedência. Sem acesso direto pela API.
  - `categories` (dois níveis) e categoria no anúncio do fornecedor.
  - `private.compute_split`: venda − taxa do marketplace − fornecedor − comissão do vendedor =
    receita da TheSigns (+ margem). Usado por `estimate_sale_split` (vendedor, anúncio visível) e
    `admin_simulate_split` (equipe).
  - RPCs da equipe para taxas, comissões e categorias; **toda alteração vai para a auditoria** com
    resumo legível ("Comissão padrão: 15.00% → 20.00%").
  - Taxas iniciais informadas pelo dono do produto: TikTok Shop (abaixo de R$ 50: 10% + R$ 4/item;
    a partir de R$ 50: 6% + R$ 6/item), Shopee Live 3%, Mercado Livre Clássico 14% e Premium 19%.
- **Telas**:
  - Equipe: **Taxas e comissões** (simulador, comissão padrão com atalhos 10/15/20/25% ou valor livre,
    exceções, regras de taxa por marketplace com faixas e campanhas, categorias).
  - Vendedor: **Calculadora de venda** no produto do catálogo (preço de venda, taxas, fornecedor,
    comissão, receita da TheSigns, lucro do vendedor, margem; aviso de prejuízo).
  - Fornecedor: escolha de categoria no anúncio do catálogo.
- **Testes**: 19 de banco (exemplo R$ 100 → R$ 29, faixas do TikTok, campanha da Shopee,
  precedência de comissões, sobreposição, auditoria, acesso) e 10 de frontend.

### Limitações conhecidas

- **Mercado Livre**: sem taxa por categoria e sem custos fixos por faixa de preço cadastrados. Os
  valores iniciais são o teto das faixas informadas (14%/19%), para não superestimar a receita.
- **Shopee fora de live** não tem taxa cadastrada: a calculadora mostra "Taxa não configurada".
- A divisão é **estimativa**: ainda não é congelada no pedido nem lançada no ledger (vem com o
  checkout Mercado Pago). Frete, impostos e taxa do meio de pagamento não entram no cálculo.
- Comissão por campanha espera a tabela de campanhas (Central de Vendas).
- O vendedor vê a receita estimada da TheSigns na calculadora, como foi pedido.

## [0.14.0] — Fase 14: Credenciais criptografadas e envio de estoque

### Adicionado

- **Banco** (`supabase/migrations/20260923170000_credentials.sql`): `integration_credentials` guarda
  só o **texto cifrado** (sem nenhum privilégio para a API; só o service role lê) e `config` não
  secreto (id do local de estoque). `store_connection_credentials` (owner/admin) e
  `connection_credentials_status` (informa apenas se está configurado). Desconectar apaga tudo.
- **Criptografia**: AES-256-GCM com `CREDENTIALS_ENCRYPTION_KEY` (segredo só das Edge Functions),
  IV aleatório por gravação e o id da conexão como dado autenticado (texto cifrado copiado para
  outra conexão não decifra). Formato versionado (`v1.iv.ct`).
- **Edge Functions**: `credentials` (JWT do usuário: valida, criptografa e guarda; nada volta ao
  navegador) e `stock-sync` (agendada; autenticada por `x-sync-secret`; reivindica lotes, decifra
  em memória, envia e conclui com backoff do banco).
- **Clientes de API** (`_shared/integrations/stock.ts`): Shopify (GraphQL `inventorySetQuantities`
  no local configurado) e WooCommerce (produto simples por SKU, Basic auth). Timeout de 15 s, sem
  seguir redirecionamentos, erros traduzidos sem vazar credenciais.
- **Anti-SSRF**: só `https://` público por nome (sem IP, porta, credenciais na URL, `localhost`,
  `.local`/`.internal`) e domínio Shopify obrigatoriamente `*.myshopify.com`.
- **Tela**: seção **Credenciais de API** na conexão (status configurado/não, formulário por provedor,
  valores nunca exibidos).
- **Testes**: 7 de banco, 16 de criptografia/SSRF/clientes de API (com `fetch` simulado) e 3 de frontend.

### Limitações conhecidas

- **Nada disto foi executado contra lojas reais nem em Deno**: os formatos de requisição seguem a
  documentação pública, mas só foram verificados com `fetch` simulado.
- Não há botão "testar conexão" (seria a primeira chamada real à API).
- WooCommerce: só produtos simples (variações não). Shopify: um local de estoque por conexão.
- SSRF: sem resolução de DNS, um domínio público que aponte para IP privado não é barrado; recomenda-se
  restringir a saída de rede da função onde a plataforma permitir.
- Rotação de chave: o formato tem versão, mas a re-criptografia em lote ainda não existe (regravar
  as credenciais pela tela usa a chave atual).

## [0.13.0] — Fase 13: IA — descrição de produto assistida

### Adicionado

- **Banco** (`supabase/migrations/20260923160000_ai.sql`): `ai_begin_description` (autoriza owner/admin,
  confere que o produto é da organização, aplica a **cota diária de 50 por organização** com lock
  para chamadas paralelas e entrega só os dados do produto para o prompt), `ai_finish` (fecha a
  reserva; falha **devolve a cota**; reserva presa expira em 5 min) e `ai_usage_today`. `ai_usage`
  registra tokens e não tem nenhum acesso pela API.
- **Edge Function** `ai` (`POST /functions/v1/ai`): roda com o **JWT do usuário** (sem service role),
  chama a API da Anthropic (SDK oficial; modelo por `AI_MODEL`, padrão `claude-opus-5`, esforço
  `low`), trata `refusal`, limita a resposta a 1024 tokens e devolve códigos de erro estáveis.
- **Prompt e limpeza** em `supabase/functions/_shared/ai/description.ts`: campos do vendedor viram
  texto de uma linha (sem injeção por quebra de linha), instrução de tratar o cadastro como dado e
  não inventar fatos; resposta sem markdown/rótulos e dentro do limite de 5000 caracteres.
- **Tela**: botão **Sugerir com IA** no produto (a partir dos dados salvos). O texto só preenche o
  campo; **nada é salvo** até a pessoa revisar e salvar. Mostra a cota restante.
- **Testes**: 7 de banco (autorização, isolamento entre organizações, dados mínimos, cota,
  expiração, fechamento único) e 9 de lógica (prompt, injeção, limpeza, modelos, mensagens).

### Limitações conhecidas

- **A Edge Function não foi executada** (sem Deno, Supabase CLI nem chave da API aqui): o banco, o
  prompt e a limpeza são testados; a chamada ao modelo e o CORS devem ser exercitados com
  `supabase functions serve ai` + `ANTHROPIC_API_KEY` antes de produção.
- Um só recurso de IA (descrição de produto). Sem fila, cache de resultados ou sugestão em lote.
- `fallbacks` de recusa do Opus 5 não foi habilitado (fluxo curto e revisável): uma recusa devolve
  "escreva manualmente". Custo: cota por organização, sem faturamento por uso.
- LGPD: o cadastro do produto (sem dados de clientes) é enviado à Anthropic para gerar o texto.

## [0.12.0] — Fase 12: Administração da plataforma

### Adicionado

- **Banco** (`supabase/migrations/20260923150000_admin.sql`):
  - **Suspensão de organização** (`organizations.suspended_at` + motivo obrigatório). Aplicada no
    ponto único `private.org_role_of`: toda policy e RPC passa a negar a organização suspensa de uma
    vez. Também: anúncios de fornecedor suspenso saem de `search_catalog`, `visible_listing` (não
    roteia pedido) e das imagens do catálogo; vendedor suspenso não recebe pedidos de marketplace.
  - `admin_audit_log`: auditoria **imutável**, sem acesso direto pela API.
  - RPCs da equipe (`profiles.role = 'admin'`): `admin_stats`, `admin_list_organizations` (busca
    sem coringas, paginada), `admin_set_suspension` (motivo obrigatório; recusa repetir estado) e
    `admin_audit_entries`. `my_suspended_organizations` explica o bloqueio aos membros.
  - A equipe vê **só agregados**: nenhuma policy dá acesso a pedidos, clientes ou financeiro.
- **Telas**: **Administração** (indicadores, organizações com suspender/reativar e motivo,
  auditoria), aviso de suspensão para os membros e menu específico para contas da equipe.
- **Testes**: 8 de banco (acesso, isolamento da equipe, agregados, busca, auditoria imutável,
  bloqueio total da suspensa, fornecedor suspenso, webhook) e 3 de frontend.

### Revisão

- O teste de suspensão de fornecedor revelou que `search_catalog` e a policy de imagens não usavam
  `visible_listing`: ambos foram redefinidos com o filtro de suspensão.

### Limitações conhecidas

- Não há criação de contas de equipe pela interface (continua via SQL, como documentado). Sem MFA
  obrigatório para a equipe ainda. Suspensão não notifica por e-mail. Pedidos já roteados a um
  fornecedor que é suspenso depois ficam parados até a reativação.

## [0.11.0] — Fase 11: Analytics

### Adicionado

- **Banco** (`supabase/migrations/20260923140000_analytics.sql`), só RPCs de leitura (sem tabelas):
  `analytics_overview`, `analytics_daily` (todos os dias da janela, inclusive vazios) e
  `analytics_top_items`. Vendedor: pedidos, receita, ticket médio, unidades, lucro bruto, pedidos
  via marketplace e funil por situação. Fornecedor: fornecimentos, faturamento (atacado), aguardando
  envio e a receber. Só owner/admin; janela de 1 a 366 dias no fuso de São Paulo; cancelados fora.
- **Tela** **Análises**: cartões, alerta de estoque baixo, barras por dia (tooltip por barra,
  `role="img"` com resumo) e mais vendidos.
- **Testes**: 7 de banco e 4 de frontend.

### Limitações conhecidas

- Lucro bruto usa o **custo atual** do cadastro para estoque próprio (não há snapshot de custo no
  pedido) e o atacado congelado para dropshipping; itens sem custo contam como zero e são avisados.
- Receita é o total do pedido (inclui frete). Sem comparação entre períodos nem exportação.

## [0.10.0] — Fase 10: Integrações de marketplace (núcleo)

### Adicionado

- **Banco** (`supabase/migrations/20260923130000_integrations.sql`): conexões, segredo de webhook
  inacessível pela API, vínculos de SKU, pedidos externos, log de eventos e outbox de estoque
  (detalhes em `DATABASE.md`). `create_order` passou a delegar a `private.create_order_core`,
  compartilhado com a ingestão de marketplace (mesmas regras, sem duplicação).
- **Edge Function** `webhooks` (`POST /functions/v1/webhooks/<provedor>/<conexão>`): verifica
  HMAC, normaliza e chama a ingestão. Normalizadores de **Shopify** e **WooCommerce** e utilitários
  (dinheiro sem float, endereço, HMAC) em `supabase/functions/_shared/integrations/`.
- **Telas**: **Integrações** (lista, nova conexão, próximos marketplaces) e página da conexão
  (URL do webhook + instruções, troca de segredo, pausar/retomar/desconectar, vínculos de SKU,
  atividade com reprocessamento).
- **Testes**: 22 de banco (segredo, permissões, vínculos, ingestão idempotente, SKU sem vínculo +
  reprocessar, preços conflitantes, dado inválido, pausa, outbox com concorrência e backoff), 14
  de normalização/assinatura e 8 de frontend.

### Limitações conhecidas

- **Só Shopify e WooCommerce**, e só **entrada de pedidos**. Mercado Livre, Shopee e TikTok Shop
  (OAuth, APIs próprias) ficam para fases próprias; aparecem como "em breve".
- **O estoque é enfileirado, mas nenhum worker o envia ainda**: falta o cliente de API de cada
  provedor (Shopify exige location/inventory item, Woo o id do produto). As RPCs de worker estão
  prontas e testadas.
- Sem devolução de rastreio/status ao marketplace; sem importação de catálogo; pedido entra
  `pending` (o vendedor confirma, o que reserva o estoque).
- Suposições de payload documentadas em `shopify.ts`/`woocommerce.ts` (número da rua a partir de
  `address1`, bairro "Não informado" sem o plugin Brazilian Market, CPF só no Woo). Validadas
  contra payloads de exemplo, **não** contra lojas reais.
- A Edge Function não foi executada aqui (sem Deno/Supabase CLI).

## [0.9.0] — Fase 9: Financeiro

### Adicionado

- **Banco** (`supabase/migrations/20260923120000_finance.sql`):
  - `ledger_entries`: livro-razão **imutável** por organização (nem owner, nem cascata, nem
    truncate), valor com sinal validado por tipo (`sale_payment`, `refund`, `supplier_payment`,
    `supplier_receipt`).
  - `order_payments` + `orders.paid_cents`/`refunded_cents`: recebimentos e estornos manuais,
    idempotentes por `request_id`, com constraint de que o líquido recebido nunca passa do total.
  - RPCs `record_order_payment`, `refund_order_payment`, `pay_supplier_order` (débito no vendedor e
    crédito no fornecedor atômicos; só após o envio; uma vez só) e `finance_summary`
    (recebido, estornos, pago/recebido de fornecedores, saldo, a pagar/a receber).
  - Dados financeiros visíveis apenas para owner/admin; escrita somente por RPC.
- **Telas**: **Financeiro** (resumo por período + lançamentos paginados, visão de vendedor e de
  fornecedor), seção **Pagamento** no pedido (situação, receber/estornar, histórico), botão de
  pagar fornecimento no pedido e aviso de pagamento na tela do fornecedor.
- **Testes**: 17 de banco (recebimento parcial/total, idempotência, excesso, estorno, acerto com
  fornecedor, imutabilidade, escrita direta bloqueada, privacidade, resumo) e 7 de frontend.

### Limitações conhecidas

- Sem gateway/conciliação: o vendedor informa o que recebeu. Sem taxas de meio de pagamento nem
  comissão da plataforma. Estorno não devolve estoque nem desfaz o acerto com fornecedor.
- Lançamentos não têm edição: erro de digitação se corrige com estorno + novo lançamento.
- O livro-razão referencia a organização sem cascata: uma organização com lançamentos não pode ser
  excluída (o produto não expõe exclusão de organização).

## [0.8.0] — Fase 8: Pedidos e encaminhamento ao fornecedor

### Adicionado

- **Banco** (`supabase/migrations/20260922180000_orders.sql`):
  - `orders` / `order_items`: pedido do vendedor com cliente, endereço (CEP, UF), frete, desconto e
    totais verificados por constraint; itens com **snapshot** de SKU, nome, atributos e preço;
    numeração sequencial por organização; criação **idempotente** por `request_id`.
  - Ciclo `pending → confirmed → shipped → delivered` (ou `cancelled` antes do envio) via RPCs
    `create_order`, `confirm_order`, `ship_order`, `deliver_order`, `cancel_order`.
  - **Estoque**: confirmar reserva (`reserved`), enviar dá baixa com movimentação `sale` no
    livro-razão (idempotente pelo id do item), cancelar libera. Tudo ou nada; itens de estoque
    travados em ordem de id (sem deadlock entre pedidos concorrentes).
  - **Dropshipping**: itens importados do catálogo geram, na confirmação, um `supplier_orders` por
    fornecedor, com atacado congelado e reserva no estoque do fornecedor. O fornecedor envia via
    `ship_supplier_order` (transportadora + rastreio), que baixa o estoque dele. O vendedor só marca
    o pedido como enviado depois de todos os fornecedores.
  - `inventory_levels` ganhou `price_cents` e `is_dropship`; motivo de estoque `sale`.
- **Telas**:
  - Vendedor: **Pedidos** (busca por nº/cliente, filtro de situação), **Novo pedido** (seletor de
    itens, validação de CPF/CNPJ e CEP, totais ao vivo) e página do pedido (ações, fornecedores com
    rastreio, cliente, histórico).
  - Fornecedor: **Fornecimentos** (lista) e página do pedido de fornecimento com confirmação de
    envio.
- `src/utils/br.ts`: CPF/CNPJ com dígito verificador, UFs, CEP.
- **Testes**: 21 de banco (ciclo, atomicidade, reservas, dropshipping, privacidade, isolamento), 1
  invariante novo de schema e 14 de frontend.

### Revisão de segurança (fechamento da fase)

- **Novo invariante**: `authenticated` só executa a lista fechada de helpers de policy do schema
  `private`. As funções internas de reserva/baixa/numeração (que não checam papel por design) ficam
  alcançáveis apenas pelas RPCs — antes isso dependia só dos privilégios padrão.
- Fornecedor recebe apenas dados de entrega (nome, telefone, documento, endereço): nunca e-mail,
  notas, preço de venda ou o pedido do vendedor. Coberto por teste.
- RPCs checam papel antes de travar linhas; pedido de outra organização e sem permissão retornam o
  mesmo erro (`orders.not_found`).
- Escrita em pedidos só por RPC (sem grants de INSERT/UPDATE/DELETE); totais verificados por
  constraint e recalculados no servidor.
- `npm run check` verde: typecheck, lint, format, 269 testes, build.

### Limitações conhecidas

- Pedidos manuais apenas (marketplaces nas fases de integração); sem edição de pedido pendente
  (cancele e recrie).
- Sem devoluções/estorno após envio; sem pagamento/repasse ao fornecedor (ledger financeiro é fase
  própria).
- O vendedor vê ids internos do fornecedor em `supplier_orders`/`supplier_order_items` (apenas
  identificadores, sem acesso a dados).
- LGPD: o vendedor deve informar ao cliente que os dados de entrega são compartilhados com o
  fornecedor responsável pelo envio.

## [0.7.0] — Fase 7: Catálogo de fornecedores

### Adicionado

- **Banco** (`supabase/migrations/20260922170000_supplier_catalog.sql`) — primeiro dado que cruza
  tenants:
  - `catalog_listings`: fornecedor publica produto com preço de atacado e preço sugerido. Só
    organizações `supplier` publicam; só produtos **ativos** e **publicados** ficam visíveis.
  - RPCs `search_catalog` e `get_catalog_listing`: vendedores consultam apenas **colunas seguras**
    (nome, descrição, marca, GTIN, medidas, preços de catálogo, disponibilidade agregada, variações
    ativas e imagens). Nunca custo, criador, ids internos do fornecedor ou linhas de `products`.
  - Só membros de organizações `seller` consultam: fornecedores não veem o catálogo uns dos outros
    (conta de fornecedor não entra em organização vendedora — regra da Fase 3).
  - RPC `import_catalog_listing`: cria produto **rascunho** no vendedor (preço = sugerido ou
    atacado; custo = atacado) com variações ativas, SKU com prefixo opcional e vínculo à origem
    (`products.source_listing_id`, `product_variants.source_variant_id`) — base para rotear pedidos.
    Uma importação por anúncio por organização.
  - Storage: vendedores leem imagens de anúncios visíveis (para exibir e copiar ao importar).
- **Telas**:
  - Fornecedor: seção **Catálogo para vendedores** na página do produto (preços, publicar).
  - Vendedor: **Catálogo** (busca por produto/marca/fornecedor, grade com capa, atacado e
    disponibilidade) e página do anúncio com importação; imagens copiadas para a pasta do vendedor.
  - Guarda `RequireOrgKind` e item de menu exclusivo para organizações vendedoras.
- Código organizado em `src/features/supplier` e `src/features/seller` (seção 4 da especificação).
- **Testes**: 17 de banco (visibilidade, vazamento de dados, importação, storage) e 7 de frontend.

### Revisão de segurança (fechamento da fase)

- **Corrigido — existência de anúncio vazava entre fornecedores**: com `unique (product_id)`, o
  índice único era verificado antes da FK composta, revelando a outro fornecedor se um produto já
  tinha anúncio. Agora `unique (organization_id, product_id)`: a FK recusa primeiro.
- Teste garante que o JSON do detalhe não contém custo, criador, id do produto/organização do
  fornecedor.
- Colunas de origem (`source_*`) não têm grant de escrita: vendedor não forja vínculo com anúncio.
- Importação checa papel e tipo da organização, visibilidade do anúncio e tamanho final do SKU
  antes de escrever; colisão de SKU vira erro claro sugerindo prefixo.
- `npm run check` verde: typecheck, lint, format, 238 testes, build.

### Limitações conhecidas

- A disponibilidade do fornecedor é exibida no momento da consulta; não há reserva de estoque do
  fornecedor na importação (virá com pedidos).
- Alterações posteriores do fornecedor (preço, descrição) não são sincronizadas com produtos já
  importados.
- A cópia de imagens roda no navegador do vendedor; falhas são informadas e podem ser refeitas
  manualmente.

## [0.6.0] — Fase 6: Estoque

### Adicionado

- **Banco** (`supabase/migrations/20260922160000_inventory.sql`):
  - `inventory_items`: um saldo por unidade vendável (produto sem variações ou cada variação),
    criado automaticamente pelo banco, com `on_hand`, `reserved` (para pedidos) e estoque mínimo.
    Produtos e variações existentes recebem saldo zerado na migração.
  - `inventory_movements`: **livro-razão imutável** — trigger bloqueia `UPDATE`, `DELETE` e
    `TRUNCATE` para qualquer papel, inclusive service role. O saldo é sempre a soma das
    movimentações.
  - RPCs `adjust_stock` (entrada, devolução, perda, ajuste) e `set_stock` (contagem): linha travada,
    saldo nunca negativo nem abaixo do reservado, sentido validado pelo motivo e **idempotência** por
    `request_id` (clique duplo ou retry não duplicam movimentação).
  - Regras de consistência: produto com variações só movimenta estoque nas variações; não se cria
    variação em produto que ainda tem saldo próprio; produto/variação com histórico não pode ser
    excluído (arquive/desative).
  - View `inventory_levels` (`security_invoker`) com disponível e indicador de estoque baixo.
- **Telas**: **Estoque** (busca, filtro de estoque baixo, paginação) e página do item (saldos,
  movimentação com prévia do saldo resultante, estoque mínimo, histórico das últimas 50).
- **Testes**: 17 de banco (livro-razão, idempotência, concorrência de regras, isolamento) e 16 de
  lógica do formulário.

### Revisão de segurança (fechamento da fase)

- RPCs de estoque checam o papel na organização **antes** de travar a linha: usuário de outra
  organização não consegue segurar locks de itens alheios.
- Item inexistente, de outra organização ou sem permissão retornam o mesmo erro
  (`inventory.item_not_found`).
- `request_id` é único por organização: não colide nem vaza entre tenants.
- Trigger de "produto com saldo" segue a regra da Fase 5 (não responde a quem não tem papel na
  organização). Coberto por teste.
- Saldo só muda pelas RPCs: sem privilégio de escrita em `on_hand`/`reserved` nem em
  `inventory_movements`.
- `npm run check` verde: typecheck, lint, format, 216 testes, build.

### Limitações conhecidas

- Um único local de estoque por organização (sem múltiplos depósitos).
- `reserved` ainda não é alimentado: passa a ser usado quando houver pedidos.
- Histórico mostra as últimas 50 movimentações (sem paginação/exportação).

## [0.5.0] — Fase 5: Variações e imagens de produto

### Adicionado

- **Banco** (`supabase/migrations/20260922150000_product_variants_images.sql`):
  - `product_variants`: unidade vendável com SKU próprio, 1–3 atributos (ex.: Cor/Tamanho, validados
    por `private.valid_variant_attributes`), preço/GTIN/peso opcionais que sobrescrevem os do
    produto, ativa/inativa. Combinação de atributos única por produto.
  - **SKU único na organização entre produtos e variações** (trigger com lock transacional por
    organização).
  - `product_images`: ordem das imagens (máx. 10 por produto, posição atribuída pelo banco) e RPC
    `set_product_image_order` (security invoker).
  - FKs compostas `(organization_id, product_id)`: filhos de um produto sempre pertencem à mesma
    organização dele.
  - **Storage**: bucket privado `product-images` (5 MB; JPEG/PNG/WebP) com policies em
    `storage.objects` — caminho obrigatório `{organização}/{produto}/{arquivo}`; membros leem,
    owner/admin enviam e excluem; sem sobrescrita.
- **Telas** (página do produto): seções **Variações** (criar, editar, ativar/desativar, excluir em
  rascunho; sugere os atributos já usados) e **Imagens** (envio múltiplo, capa, reordenar, excluir;
  URLs assinadas de 1h).
- Emulação mínima do Storage no banco de teste (`storage.buckets`, `storage.objects`).
- **Testes**: 17 de banco (variações, imagens, storage) e 14 de lógica de frontend.

### Revisão de segurança (fechamento da fase)

- **Corrigido — oráculo entre tenants**: triggers `BEFORE INSERT` rodam antes do `WITH CHECK` da RLS.
  Os triggers `security definer` de SKU e de limite de imagens respondiam `products.sku_taken` /
  `products.image_limit` a quem tentasse inserir em organização alheia, revelando SKUs e contagem de
  imagens de outro tenant. Agora, para usuário logado sem papel owner/admin na organização, os
  triggers não fazem nada e a RLS recusa normalmente. Service role (sem `auth.uid()`) continua
  sujeita às regras. Coberto por 2 testes de regressão.
- Upload: o arquivo é removido se o registro em `product_images` for recusado (sem órfãos).
- Exclusão de imagem apaga o registro antes do arquivo: o produto nunca aponta para arquivo ausente.
- Verificado: variação/imagem não mudam de produto ou organização; caminho de imagem fora da pasta
  do produto, com `..` ou extensão não permitida é recusado pelo banco; `anon` não lê o bucket.
- `npm run check` verde: typecheck, lint, format, 185 testes, build.

### Limitações conhecidas

- Excluir um produto rascunho remove os registros das imagens, mas os arquivos ficam no bucket
  (privados e inacessíveis pela API, pois a policy exige que o produto exista). Limpeza por job com
  service role em fase futura.
- Tipo/tamanho do arquivo são validados pelo Storage pelo `Content-Type` declarado, sem inspeção do
  conteúdo; o bucket é privado e servido por URL assinada fora da origem do app.

## [0.4.0] — Fase 4: Produtos (catálogo interno)

### Adicionado

- **Banco** (`supabase/migrations/20260922140000_products.sql`): tabela `products` por organização —
  SKU (único por organização, sem diferenciar maiúsculas), nome, descrição, marca, GTIN, preço e
  custo em **centavos** (`bigint`), peso/dimensões para frete e status `draft`/`active`/`archived`.
- **Permissões**: membros leem; owner/admin criam e editam; só rascunhos podem ser excluídos
  (os demais são arquivados). `organization_id`, `created_by` e datas não são graváveis pelo
  cliente depois da criação (grants por coluna).
- **Telas**: **Produtos** (busca por nome/SKU, filtro de status, paginação de 25, estado vazio) e
  formulário de produto (criar/editar, margem bruta calculada, excluir rascunho). Membros veem em
  modo leitura.
- `src/utils/money.ts`: conversão BRL ↔ centavos só com aritmética de strings (sem erro de ponto
  flutuante).
- Validação de GTIN/EAN com dígito verificador GS1 no formulário.
- **Testes**: 11 de RLS/regras de produtos, 21 de dinheiro, 23 de schema/busca/erros de produto.

### Revisão de segurança (fechamento da fase)

- Busca livre entra num filtro `or=(…)` do PostgREST: `sanitizeSearch` remove `,()"\` e curingas
  antes de montar o filtro (coberto por teste). Mesmo um filtro manipulado continuaria limitado pela
  RLS às organizações do usuário.
- `UPDATE`/`DELETE` negados pela RLS retornam 0 linhas sem erro; o frontend trata "0 linhas" como
  falha em vez de exibir sucesso falso.
- Verificado: produto não muda de organização nem tem autoria forjada; membro comum não escreve;
  usuário de outra organização não lê, edita nem exclui; `anon` sem acesso; tabela coberta pelas
  invariantes de `rls-baseline.test.ts`.
- `npm run check` verde: typecheck, lint, format, 157 testes, build.

### Limitações conhecidas

- Sem variações (cor/tamanho) e sem imagens: entram em fase própria.
- Sem limite de produtos por organização (rate limiting é da Fase 22).
- Excluir uma organização apaga seus produtos em cascata; quando houver pedidos, as referências
  usarão `restrict`.

## [0.3.0] — Fase 3: Organizações (tenants) e RLS deny-by-default

### Adicionado

- **Banco** (`supabase/migrations/20260922130000_organizations.sql`): `organizations`,
  `organization_members` e `organization_invitations`, com papéis `owner`/`admin`/`member` e tipo
  (`seller`/`supplier`) herdado da conta de quem cria.
- **Deny-by-default**: tabelas, sequências e funções novas do schema `public` nascem sem acesso para
  `anon`/`authenticated`; cada migração concede explicitamente o que precisa.
- **Isolamento por tenant**: RLS com helpers `private.is_org_member` / `private.has_org_role`
  (schema `private`, fora da API). Usuário só enxerga organizações das quais é membro.
- **RPCs** com regras explícitas: criar organização, listar membros, convidar/revogar, aceitar/recusar
  convite, alterar papel, remover membro/sair. Organização sempre mantém ao menos um owner (operações
  serializadas por lock na organização).
- **Testes**: 28 testes de isolamento/papéis/convites e 7 invariantes de schema
  (`src/test/db/rls-baseline.test.ts`): RLS em toda tabela, `anon` sem privilégios, objetos novos sem
  acesso, lista fechada de RPCs executáveis, `search_path` fixo em funções `security definer`.
- **Telas**: onboarding "Configure sua organização" (criar ou aceitar convite), **Organização**
  (dados, membros e papéis, convites, sair), convites pendentes na página inicial e seletor de
  organização ativa no topo.
- Componentes `Section`, `Select`, `ConfirmButton`.

### Alterado

- Testes nunca usam o Supabase real, mesmo com `.env.local` preenchido.
- Banco de teste migrado uma vez por arquivo e restaurado de snapshot (suíte de banco ~3× mais
  rápida).
- `Section` extraído de Minha conta para `src/components/ui`.

### Revisão de segurança (fechamento da fase)

- Convites passaram a exigir e-mail **confirmado** no SQL (`email_confirmed_at`), sem depender só
  da opção "Confirm email" do painel — do contrário, um cadastro com o e-mail de outra pessoa
  aceitaria o convite dela. Coberto por teste.
- `public.set_updated_at()` (Fase 2) tinha `EXECUTE` para `PUBLIC` por padrão; revogado.
- Verificado: RPCs recusam organização alheia; ids de convite/organização adivinhados não revelam
  existência (mesmo erro); `kind`/`created_by` e papéis não são alteráveis por `UPDATE` direto;
  corrida entre dois owners se rebaixando é serializada por `select … for update`.
- `npm run check` verde: typecheck, lint, format, 103 testes, build.

## [0.2.0] — Fase 2: Autenticação, sessão e RBAC

### Adicionado

- **Banco** (`supabase/migrations/20260922120000_auth_profiles.sql`): enum `app_role`
  (`seller`, `supplier`, `admin`) e tabela `profiles` 1:1 com `auth.users`, criada por trigger no
  cadastro. RLS habilitada; usuário lê/edita apenas o próprio perfil e só pode alterar `full_name`.
  `admin` nunca é atribuído a partir dos metadados do cliente.
- **Testes de banco sem Docker**: PGlite (Postgres em WASM) com emulação mínima do Supabase
  (`src/test/db/supabase-sim.ts`); 12 testes de RLS/privilégios rodam em `npm test`.
- **Telas**: Entrar, Criar conta (Vendedor/Fornecedor), Recuperar senha, Redefinir senha, Início e
  Minha conta (editar nome, trocar senha com reautenticação por código, sair).
- **Sessão**: `AuthProvider` (PKCE, restauração de sessão, cache do TanStack Query limpo ao sair ou
  trocar de usuário).
- **Rotas**: `RequireAuth` (preserva `?next`), `RedirectIfAuthenticated` (com proteção contra open
  redirect), `RequireRole` (RBAC de UX; a autorização real é a RLS).
- **Throttling de login**: backoff no cliente após 3 falhas (15s → 5min) + rate limit do Supabase
  Auth reduzido para 15 tentativas/5min por IP.
- Componentes de UI: `Button`, `TextField`, `Alert`, `PageLoader`. Navegação móvel no AppShell.
- `/status` continua público (funciona sem Supabase configurado).

## [0.1.0] — Fase 1: Setup

### Adicionado

- Projeto React + TypeScript (strict) + Vite + Tailwind CSS v4.
- React Router, TanStack Query, Zod, React Hook Form, supabase-js.
- ESLint (flat config, typescript-eslint, react-hooks) + Prettier (com plugin Tailwind).
- Vitest + Testing Library + jsdom.
- Estrutura modular de pastas (`src/features`, `src/integrations`, `supabase/functions`, …).
- Validação do ambiente público (`src/lib/env.ts`) e cliente Supabase opcional (PKCE).
- Design tokens light/dark e alternância de tema.
- AppShell (sidebar, topbar, conteúdo) e página **Status do sistema**.
- Configuração do Supabase local (`supabase/config.toml`).
- `.env.example`, README, ARCHITECTURE, ENVIRONMENT, SECURITY.

### Corrigido (fechamento da fase)

- `devDependencies` ausentes no `package.json` (TypeScript, Vite, ESLint, Prettier, Vitest, Supabase CLI…) — instaladas.
- `supabase/config.toml` gerado e ajustado: `site_url` na porta 5173, seeds em `supabase/seed/*.sql`,
  confirmação de e-mail obrigatória, senha mínima de 10 caracteres (maiúsculas, minúsculas e dígitos),
  reautenticação para troca de senha.
- `npm run check` verde (typecheck, lint, format, 6 testes, build).
