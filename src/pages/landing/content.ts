import {
  BadgeCheck,
  Boxes,
  CreditCard,
  GraduationCap,
  Link2,
  PiggyBank,
  Plug,
  ShieldCheck,
  Store,
  Truck,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

/**
 * Textos da landing page (Fase 25). Só descrevem o que o sistema faz hoje:
 * nada de depoimentos, números de clientes ou preços inventados. Recursos
 * ainda não entregues aparecem como "em preparação".
 */

export interface Feature {
  icon: LucideIcon;
  title: string;
  text: string;
}

export const steps: Feature[] = [
  {
    icon: Store,
    title: 'Escolha produtos',
    text: 'Importe produtos do catálogo de fornecedores aprovados, com preço de atacado, preço sugerido, fotos e material de divulgação.',
  },
  {
    icon: Link2,
    title: 'Divulgue e venda',
    text: 'Venda pelo checkout próprio (Pix, cartão e boleto pelo Mercado Pago) com sua vitrine, links rastreáveis e QR Code.',
  },
  {
    icon: Truck,
    title: 'O fornecedor envia',
    text: 'Com o pagamento aprovado, o pedido vai direto ao fornecedor, que separa, envia e informa o rastreio.',
  },
  {
    icon: Wallet,
    title: 'Receba na carteira',
    text: 'Sua comissão entra na carteira e é liberada após a entrega e o prazo de garantia. O saque é por Pix.',
  },
];

export const sellerFeatures: Feature[] = [
  {
    icon: Boxes,
    title: 'Sem estoque próprio',
    text: 'Você vende; o fornecedor guarda e envia. O estoque do fornecedor é conferido a cada venda.',
  },
  {
    icon: CreditCard,
    title: 'Checkout pronto',
    text: 'Página de compra para cada produto, sem o comprador precisar criar conta.',
  },
  {
    icon: PiggyBank,
    title: 'Ganho claro antes de vender',
    text: 'Calculadora de preço-alvo e simulador de lucro com as taxas reais de cada marketplace.',
  },
  {
    icon: Plug,
    title: 'Sua loja conectada',
    text: 'Integração com o Mercado Livre para pedidos, estoque, etiqueta e nota fiscal. Shopee e TikTok Shop em preparação.',
  },
];

export const supplierFeatures: Feature[] = [
  {
    icon: Store,
    title: 'Uma rede de vendedores',
    text: 'Publique seus produtos com preço de atacado e sugerido; vendedores importam e divulgam.',
  },
  {
    icon: Truck,
    title: 'Pedidos organizados',
    text: 'Cada venda vira um pedido de fornecimento com endereço do comprador e espaço para o rastreio.',
  },
  {
    icon: Wallet,
    title: 'Recebimento pela plataforma',
    text: 'Nas vendas pelo checkout, o atacado entra na sua carteira: não é preciso cobrar cada vendedor.',
  },
  {
    icon: BadgeCheck,
    title: 'Catálogo com curadoria',
    text: 'Fornecedores e anúncios passam por análise da equipe antes de aparecer para os vendedores.',
  },
];

export const academyPoints = [
  'Cursos em vídeo sobre venda online, divulgação e operação',
  'Progresso salvo por aula e perguntas para a equipe',
  'Certificado ao concluir, com código de verificação',
];

export const pricingPoints = [
  'Criar conta de vendedor ou de fornecedor é gratuito.',
  'Nas vendas pelo checkout, a TheSigns fica com o que sobra depois da taxa do Mercado Pago, do atacado do fornecedor e da comissão do vendedor.',
  'A comissão de cada produto aparece antes de você ligar o checkout — sem surpresa.',
  'Planos pagos (destaque de produto e campanhas) ainda não existem; quando existirem, serão opcionais.',
];

export interface Faq {
  question: string;
  answer: string;
}

export const faqs: Faq[] = [
  {
    question: 'Preciso ter estoque para vender?',
    answer:
      'Não. Você importa produtos do catálogo de fornecedores e o fornecedor envia direto para o comprador. Se preferir, também pode cadastrar produtos e estoque próprios.',
  },
  {
    question: 'Como recebo pelas vendas?',
    answer:
      'O comprador paga pelo Mercado Pago (Pix, cartão ou boleto). Sua comissão entra na carteira como pendente e é liberada após a entrega mais o prazo de garantia; depois é só solicitar o saque por Pix.',
  },
  {
    question: 'Quanto custa?',
    answer:
      'Criar conta é gratuito. A TheSigns ganha uma parte de cada venda feita pelo checkout, depois das taxas, do fornecedor e da sua comissão. A comissão de cada produto é mostrada antes de você vender.',
  },
  {
    question: 'Posso vender nos marketplaces?',
    answer:
      'Hoje há integração com o Mercado Livre. As integrações com Shopee e TikTok Shop estão em preparação e dependem da aprovação de cada plataforma.',
  },
  {
    question: 'Quem pode ser fornecedor?',
    answer:
      'Empresas que passam pela análise da equipe. Cada anúncio também é revisado antes de aparecer no catálogo.',
  },
  {
    question: 'Meus dados e os dos compradores estão seguros?',
    answer:
      'Cada empresa só acessa os próprios dados (regras no banco de dados), os dados do cartão ficam só com o Mercado Pago e as credenciais de integração são guardadas criptografadas.',
  },
];

export const trustPoints: Feature[] = [
  {
    icon: ShieldCheck,
    title: 'Dados isolados por empresa',
    text: 'Regras de acesso no próprio banco de dados.',
  },
  {
    icon: CreditCard,
    title: 'Pagamentos pelo Mercado Pago',
    text: 'O cartão nunca passa pelos nossos servidores.',
  },
  {
    icon: GraduationCap,
    title: 'Aprenda enquanto vende',
    text: 'Academia com cursos e certificados.',
  },
];
