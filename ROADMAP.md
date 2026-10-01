# Roadmap

Consolida a especificação original do TheSigns (fases 1–14) com a especificação ampliada de
**ecossistema de dropshipping + social commerce + educação** (seções 1–46) e com as decisões do dono
do produto de 2026-09-23. Os princípios do [ARCHITECTURE.md](ARCHITECTURE.md) continuam valendo e têm
prioridade: segurança, RLS deny-by-default, dinheiro em ledger imutável, **nenhuma funcionalidade ou
integração fictícia** ("Não configurado" / "Não suportado pela API atual").

## Decisões do dono do produto (2026-09-23)

- **Pagamentos: Mercado Pago**, com **checkout próprio** da plataforma (PIX, cartão, boleto).
- **Vídeos da Academia no YouTube**: a aula guarda o link e o player abre o vídeo a partir dele.
- **MVP sem mentores.** A venda se divide em 4 partes: **marketplace, fornecedor, vendedor/criador e
  TheSigns**. Receita da TheSigns = venda − taxas do marketplace − fornecedor − comissão do vendedor.
- **Nenhuma taxa fixa no código.** Taxas por marketplace, categoria, tipo de anúncio e campanha,
  editáveis pela equipe (Fase 15). Comissão padrão do vendedor: 15%, com exceções por produto,
  categoria, vendedor e (quando existirem) campanha.

## Decisões de encaixe (spec ampliada → modelo existente)

| Spec ampliada                                           | Como entra no que já existe                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tabelas `users`, `suppliers`, `products`, `wallets`...  | Mantidos os nomes atuais (`profiles`, `organizations` kind `supplier`/`seller`, `catalog_listings`, `ledger_entries`...). Tabelas novas só para domínios novos.                                                                                                          |
| Perfis ADMIN / FORNECEDOR / VENDEDOR / CRIADOR          | `app_role` + `org_kind` já cobrem admin/fornecedor/vendedor. **Criador** = vendedor. Mentor fica fora do MVP (fase 40).                                                                                                                                                  |
| Status de pedido (8)                                    | Ciclo atual `pending → confirmed → shipped → delivered / cancelled` + pagamento em `paid_cents`/`refunded_cents`. Acrescentar `in_transit` (rastreio) e o status derivado `refunded`; "aguardando pagamento" e "aguardando fornecedor" são derivados, não novos estados. |
| Divisão da venda                                        | Calculada no banco a partir de `marketplace_fee_rules` e `commission_rules` (Fase 15). Com o checkout, a divisão passa a ser **congelada no pedido** e lançada no ledger (pendente → disponível após o prazo de garantia).                                               |
| Carteira interna e saques                               | Carteira = visão do ledger (disponível / pendente / bloqueado). Saque = solicitação aprovada pelo admin e **paga pelo Mercado Pago** (a plataforma não custodia dinheiro por conta própria).                                                                             |
| Publicação no marketplace com progresso "em tempo real" | Cada etapa exibida corresponde a uma chamada/estado real registrado em `integration_events`. Nada de animação encenada.                                                                                                                                                  |
| Etiquetas                                               | Somente via API oficial (etiqueta do próprio marketplace, ou Melhor Envio/Correios com contrato). Sem API configurada: upload manual do PDF da etiqueta e vínculo ao pedido.                                                                                             |
| Afiliados: vendas e conversão                           | Venda atribuída pelo **checkout próprio** (link/código do vendedor). Pedidos de marketplace: atribuição pela conta conectada do vendedor.                                                                                                                                |
| Ferramentas com IA                                      | Reaproveita a Edge Function `ai` (cota por organização, saída revisável, nada salvo sem revisão).                                                                                                                                                                        |
| Dados de exemplo                                        | Seed só em desenvolvimento, marcado como tal. Depoimentos/produtos da landing não podem ser inventados.                                                                                                                                                                  |

## Entregue (v0.1 – v0.36)

1 Setup · 2 Auth/sessão/RBAC · 3 Organizações + RLS · 4 Produtos · 5 Variações/imagens · 6 Estoque
(ledger) · 7 Catálogo de fornecedores · 8 Pedidos + roteamento ao fornecedor · 9 Financeiro (ledger)
· 10 Integrações (núcleo, webhooks Shopify/Woo) · 11 Analytics · 12 Admin da plataforma · 13 IA
(descrição) · 14 Credenciais criptografadas + envio de estoque · **15 Taxas de marketplace, comissão
do vendedor, categorias e calculadora da divisão** · **16 Moderação de fornecedores e anúncios** · **17 Academia (YouTube)** · **18 Onboarding e painel do vendedor** · **19 Central de Vendas e campanhas para lives** · **20 Ferramentas (preço-alvo, simulador de lucro, textos com IA)** · **21 Checkout próprio + Mercado Pago** · **22 Carteira e saques** · **23 Afiliados e indicação (links, vitrine, QR Code, atribuição e indique e ganhe)** · **24 Notificações em tempo real e alertas** · **25 Landing page** · **26 Rate limiting, endurecimento e MFA da equipe** · **27 Suporte e denúncias** · **28 Avaliações e reputação** · **29 Gerenciador de anúncios e publicação (Shopify/WooCommerce)** · **30 Etiquetas de envio (upload e vínculo)** · **31 Mercado Livre (OAuth, pedidos e estoque)** · **32 Envio automático ao fornecedor com etiqueta e nota fiscal do Mercado Livre** · **33 Ambientes separados (vendedor, fornecedor e equipe) e só Mercado Livre, Shopee e TikTok Shop** · **34 Configuração por canal no cadastro do produto** · **35 Catálogo aberto (sem aprovação), lojas de fornecedores, exportar com ferramentas no produto** · **36 Estoque por planilha e integração com Bling/Tiny**.

## Próximas fases

Ordem pensada para fechar primeiro o **MVP da seção 26** e depois o ecossistema.

| Fase  | Entrega                                                                                                                          | Seções |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 37    | **Publicar no Mercado Livre** a partir da configuração do canal (categoria e atributos obrigatórios pela API, fotos, variações). | 11     |
| 38–39 | **Shopee e TikTok Shop** — uma fase por marketplace, cada uma dependente de app de desenvolvedor aprovado.                       | 11, 38 |
| 40    | **Mentoria e Comunidade** (fora do MVP): mentores, comissão de mentor, aulas ao vivo, grupos, desafios.                          | 8, 44  |
| 41    | **Gamificação**: pontos por eventos reais, níveis, conquistas, ranking — configurável.                                           | 45     |
| 42    | **Planos e monetização**: assinaturas de fornecedor/vendedor, destaque de produto, campanhas patrocinadas.                       | 25     |

Cada fase segue o mesmo fechamento: migração com RLS, testes de banco e frontend, `npm run check`
verde, revisão de segurança e entrada no [CHANGELOG.md](CHANGELOG.md).

## Pontos em aberto

1. **Mercado Livre**: taxa exata por categoria e custos fixos por faixa de preço. Hoje valem 14%
   (Clássico) e 19% (Premium), o teto das faixas informadas, até a equipe cadastrar por categoria.
2. **Shopee fora de live**: nenhuma taxa cadastrada ("Taxa não configurada" até a equipe cadastrar).
3. **Pedidos de marketplace x divisão**: no checkout (Fase 21) a plataforma recebe e repassa. Pedidos
   de marketplace continuam caindo na conta do vendedor, que paga o atacado (Fase 9); a cobrança da
   parte da TheSigns nesses pedidos ainda precisa de regra (a carteira da Fase 22 cobre só o checkout).
4. **Preço no checkout** (decidido provisoriamente na Fase 21): vale o preço do produto do vendedor,
   com piso = fornecedor + comissão; a TheSigns fica com o restante. Confirmar com o dono do produto
   (alternativa: preço sugerido do fornecedor fixo).
5. **Frete no checkout e etiquetas por API**: frete hoje incluso no preço; cotação real, geração de
   etiqueta e "em trânsito" automático dependem de contrato com Melhor Envio/Correios (Fase 30 entregou
   o upload manual).
6. **Repasse automático de saques**: hoje a equipe faz o PIX no painel do Mercado Pago e registra
   o identificador. Automatizar depende de liberação da API de Money Out na conta da plataforma.
7. **Certificados**: PDF gerado na Edge Function com código de verificação público.
8. **Indique e ganhe**: programa entregue desligado (Fase 23). A equipe precisa definir recompensa,
   venda mínima e prazo em Administração → Indicações antes de divulgar.
9. **Cabeçalhos de segurança (CSP)**: dependem da hospedagem do frontend (Vercel, Netlify,
   Cloudflare…), ainda não definida. Precisam liberar Supabase, Mercado Pago (Payment Brick) e YouTube.
10. **Canais (Fase 33)**: só Mercado Livre, Shopee e TikTok Shop. Shopify, WooCommerce e Amazon
    saíram do produto (decisão do dono, 2026-10-01).
11. **Mercado Livre (Fase 31)**: falta criar o app do Mercado Livre e cadastrar os segredos
    (`MERCADOLIVRE_CLIENT_ID`, `MERCADOLIVRE_CLIENT_SECRET`, `APP_URL`) e assinar os tópicos `orders_v2` e
    `shipments` (Fase 32: etiqueta e nota fiscal ao fornecedor); publicar anúncio no Mercado
    Livre e trazer perguntas/mensagens ficam para depois.
12. **ERP (Fase 36)**: criar o app no Bling (URL de retorno `<SUPABASE_URL>/functions/v1/erp/callback`)
    e cadastrar `BLING_CLIENT_ID`/`BLING_CLIENT_SECRET`; agendar `erp/cron`. No Tiny, o vendedor
    instala a extensão "API para estoque em tempo real". Variações do Bling dependem de o SKU da
    variação ser o mesmo daqui. Validar com contas de teste dos dois ERPs.
