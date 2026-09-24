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
| Perfis ADMIN / FORNECEDOR / VENDEDOR / CRIADOR          | `app_role` + `org_kind` já cobrem admin/fornecedor/vendedor. **Criador** = vendedor. Mentor fica fora do MVP (fase 35).                                                                                                                                                  |
| Status de pedido (8)                                    | Ciclo atual `pending → confirmed → shipped → delivered / cancelled` + pagamento em `paid_cents`/`refunded_cents`. Acrescentar `in_transit` (rastreio) e o status derivado `refunded`; "aguardando pagamento" e "aguardando fornecedor" são derivados, não novos estados. |
| Divisão da venda                                        | Calculada no banco a partir de `marketplace_fee_rules` e `commission_rules` (Fase 15). Com o checkout, a divisão passa a ser **congelada no pedido** e lançada no ledger (pendente → disponível após o prazo de garantia).                                               |
| Carteira interna e saques                               | Carteira = visão do ledger (disponível / pendente / bloqueado). Saque = solicitação aprovada pelo admin e **paga pelo Mercado Pago** (a plataforma não custodia dinheiro por conta própria).                                                                             |
| Publicação no marketplace com progresso "em tempo real" | Cada etapa exibida corresponde a uma chamada/estado real registrado em `integration_events`. Nada de animação encenada.                                                                                                                                                  |
| Etiquetas                                               | Somente via API oficial (etiqueta do próprio marketplace, ou Melhor Envio/Correios com contrato). Sem API configurada: upload manual do PDF da etiqueta e vínculo ao pedido.                                                                                             |
| Afiliados: vendas e conversão                           | Venda atribuída pelo **checkout próprio** (link/código do vendedor). Pedidos de marketplace: atribuição pela conta conectada do vendedor.                                                                                                                                |
| Ferramentas com IA                                      | Reaproveita a Edge Function `ai` (cota por organização, saída revisável, nada salvo sem revisão).                                                                                                                                                                        |
| Dados de exemplo                                        | Seed só em desenvolvimento, marcado como tal. Depoimentos/produtos da landing não podem ser inventados.                                                                                                                                                                  |

## Entregue (v0.1 – v0.17)

1 Setup · 2 Auth/sessão/RBAC · 3 Organizações + RLS · 4 Produtos · 5 Variações/imagens · 6 Estoque
(ledger) · 7 Catálogo de fornecedores · 8 Pedidos + roteamento ao fornecedor · 9 Financeiro (ledger)
· 10 Integrações (núcleo, webhooks Shopify/Woo) · 11 Analytics · 12 Admin da plataforma · 13 IA
(descrição) · 14 Credenciais criptografadas + envio de estoque · **15 Taxas de marketplace, comissão
do vendedor, categorias e calculadora da divisão** · **16 Moderação de fornecedores e anúncios** · **17 Academia (YouTube)**.

## Próximas fases

Ordem pensada para fechar primeiro o **MVP da seção 26** e depois o ecossistema.

| Fase  | Entrega                                                                                                                                                                                                                                   | Seções         |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 18    | **Onboarding e dashboard do vendedor**: checklist calculado de dados reais, dashboard "quanto vendi / ganhei / tenho a receber / o que vender", gráficos por dia/semana/mês/canal; cadastro com telefone e CPF/CNPJ.                      | 2, 3, 43       |
| 19    | **Central de Vendas**: biblioteca de materiais por produto (vídeos, imagens, roteiros, títulos, hashtags, argumentos), download, favoritos, "em alta"/"maior margem" com dados reais, **campanhas para lives** (e comissão por campanha). | 7, 4, 9        |
| 20    | **Ferramentas**: calculadora de preço-alvo (a partir da margem desejada, usando as taxas da Fase 15 + impostos, frete e antecipação), simulador de lucro, geradores com IA (título, descrição, copy, roteiro TikTok/live).                | 34, 36         |
| 21    | **Checkout próprio + Mercado Pago**: PIX/cartão/boleto, webhooks de pagamento, divisão congelada no pedido, lançamentos por parte no ledger.                                                                                              | 16, 9, 10      |
| 22    | **Carteira e saques**: disponível/pendente/bloqueado, solicitação de saque, aprovação da equipe, pagamento via Mercado Pago.                                                                                                              | 16             |
| 23    | **Afiliados e indicação**: link/código/QR, página pública do vendedor, cliques, visitas e vendas atribuídas pelo checkout, recompensa de indicação configurável.                                                                          | 14, 15         |
| 24    | **Notificações em tempo real** (Supabase Realtime) e alertas de estoque baixo/esgotado/alteração de preço ou fornecedor.                                                                                                                  | 21, 13         |
| 25    | **Landing page** pública (headline, como funciona, vendedores, fornecedores, Academia, planos, FAQ, CTA) — sem depoimentos inventados.                                                                                                    | 24             |
| 26    | **Rate limiting e endurecimento**, MFA para equipe.                                                                                                                                                                                       | 27             |
| 27    | **Suporte e denúncias**: tickets por categoria com conversa usuário ↔ suporte.                                                                                                                                                            | 20             |
| 28    | **Avaliações e reputação**: estrelas/comentários + métricas objetivas (vendas, taxa de entrega, taxa de cancelamento).                                                                                                                    | 19             |
| 29    | **Gerenciador de anúncios e publicação** (Shopify/Woo primeiro): criar, editar, duplicar, pausar, preço/estoque, fluxo de publicação por etapas reais, logs de sincronização.                                                             | 12, 35, 37, 42 |
| 30    | **Etiquetas**: upload/vínculo manual e geração via API oficial quando houver; status `in_transit`.                                                                                                                                        | 41, 10         |
| 31–34 | **Mercado Livre, Shopee, TikTok Shop, Amazon (SP-API)** — uma fase por marketplace, cada uma dependente de app de desenvolvedor aprovado.                                                                                                 | 11, 38         |
| 35    | **Mentoria e Comunidade** (fora do MVP): mentores, comissão de mentor, aulas ao vivo, grupos, desafios.                                                                                                                                   | 8, 44          |
| 36    | **Gamificação**: pontos por eventos reais, níveis, conquistas, ranking — configurável.                                                                                                                                                    | 45             |
| 37    | **Planos e monetização**: assinaturas de fornecedor/vendedor, destaque de produto, campanhas patrocinadas.                                                                                                                                | 25             |

Cada fase segue o mesmo fechamento: migração com RLS, testes de banco e frontend, `npm run check`
verde, revisão de segurança e entrada no [CHANGELOG.md](CHANGELOG.md).

## Pontos em aberto

1. **Mercado Livre**: taxa exata por categoria e custos fixos por faixa de preço. Hoje valem 14%
   (Clássico) e 19% (Premium), o teto das faixas informadas, até a equipe cadastrar por categoria.
2. **Shopee fora de live**: nenhuma taxa cadastrada ("Taxa não configurada" até a equipe cadastrar).
3. **Modelo de receita x fluxo atual de pedidos**: hoje o vendedor registra o recebimento e paga o
   atacado ao fornecedor (Fase 9). Com o checkout próprio (Fase 21) a plataforma recebe e repassa
   fornecedor e vendedor; pedidos de marketplace continuam caindo na conta do vendedor, então o
   acerto desses pedidos precisa de regra própria (definir na Fase 21).
4. **Certificados**: PDF gerado na Edge Function com código de verificação público.
