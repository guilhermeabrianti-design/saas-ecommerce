import { useEffect } from 'react';
import { Link } from 'react-router';
import { ArrowRight, Check, ChevronDown, GraduationCap } from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import {
  academyPoints,
  faqs,
  pricingPoints,
  sellerFeatures,
  steps,
  supplierFeatures,
  trustPoints,
  type Feature,
} from './content';

const nav = [
  ['#como-funciona', 'Como funciona'],
  ['#vendedores', 'Vendedores'],
  ['#fornecedores', 'Fornecedores'],
  ['#academia', 'Academia'],
  ['#planos', 'Planos'],
  ['#faq', 'Dúvidas'],
] as const;

function CtaLink({
  to,
  children,
  variant = 'primary',
}: {
  to: string;
  children: React.ReactNode;
  variant?: 'primary' | 'secondary';
}) {
  return (
    <Link
      to={to}
      className={
        variant === 'primary'
          ? 'bg-brand text-brand-fg hover:bg-brand/90 inline-flex h-11 items-center gap-2 rounded-lg px-5 text-sm font-semibold'
          : 'border-border bg-surface hover:bg-surface-2 inline-flex h-11 items-center gap-2 rounded-lg border px-5 text-sm font-semibold'
      }
    >
      {children}
    </Link>
  );
}

function SectionHeading({
  id,
  eyebrow,
  title,
  text,
}: {
  id: string;
  eyebrow: string;
  title: string;
  text: string;
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-brand text-sm font-semibold">{eyebrow}</p>
      <h2 id={id} className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
        {title}
      </h2>
      <p className="text-muted mt-3">{text}</p>
    </div>
  );
}

function FeatureGrid({
  items,
  columns = 'sm:grid-cols-2',
}: {
  items: Feature[];
  columns?: string;
}) {
  return (
    <ul className={`mt-10 grid gap-4 ${columns}`}>
      {items.map(({ icon: Icon, title, text }) => (
        <li key={title} className="border-border bg-surface rounded-xl border p-5">
          <span className="bg-brand/10 text-brand flex size-10 items-center justify-center rounded-lg">
            <Icon className="size-5" aria-hidden />
          </span>
          <h3 className="mt-4 font-semibold">{title}</h3>
          <p className="text-muted mt-1 text-sm">{text}</p>
        </li>
      ))}
    </ul>
  );
}

/** Página pública (Fase 25). Só descreve o que existe hoje. */
export function LandingPage() {
  useEffect(() => {
    document.title = 'TheSigns — venda sem estoque com fornecedores e checkout próprio';
    return () => {
      document.title = 'TheSigns';
    };
  }, []);

  return (
    <div className="bg-canvas min-h-full">
      <header className="border-border bg-canvas/90 sticky top-0 z-40 border-b backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4">
          <Link to="/" aria-label="TheSigns — início">
            <Logo />
          </Link>
          <nav className="hidden flex-1 gap-5 text-sm lg:flex" aria-label="Seções">
            {nav.map(([href, label]) => (
              <a key={href} href={href} className="text-muted hover:text-fg">
                {label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <Link
              to="/entrar"
              className="hover:bg-surface-2 rounded-lg px-3 py-2 text-sm font-medium"
            >
              Entrar
            </Link>
            <Link
              to="/cadastro"
              className="bg-brand text-brand-fg hover:bg-brand/90 hidden rounded-lg px-3 py-2 text-sm font-semibold sm:inline-flex"
            >
              Criar conta
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section className="px-4 pt-16 pb-20 sm:pt-24" aria-labelledby="hero">
          <div className="mx-auto max-w-3xl text-center">
            <h1
              id="hero"
              className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl"
            >
              Venda produtos de fornecedores sem ter estoque
            </h1>
            <p className="text-muted mx-auto mt-5 max-w-2xl text-lg text-pretty">
              A TheSigns junta catálogo de fornecedores, checkout com Pix, cartão e boleto, links de
              divulgação e carteira com saque por Pix. Você vende, o fornecedor envia.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <CtaLink to="/cadastro">
                Quero vender
                <ArrowRight className="size-4" aria-hidden />
              </CtaLink>
              <CtaLink to="/cadastro?conta=fornecedor" variant="secondary">
                Sou fornecedor
              </CtaLink>
            </div>
            <p className="text-muted mt-4 text-sm">Cadastro gratuito.</p>
          </div>
        </section>

        <section id="como-funciona" className="bg-surface-2/50 px-4 py-20" aria-labelledby="como">
          <div className="mx-auto max-w-6xl">
            <SectionHeading
              id="como"
              eyebrow="Como funciona"
              title="Da escolha do produto ao saque"
              text="Cada etapa é registrada: pagamento, pedido ao fornecedor, envio, entrega e liberação da comissão."
            />
            <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {steps.map(({ icon: Icon, title, text }, i) => (
                <li key={title} className="border-border bg-surface rounded-xl border p-5">
                  <div className="flex items-center gap-3">
                    <span className="bg-brand text-brand-fg flex size-8 items-center justify-center rounded-full text-sm font-semibold">
                      {i + 1}
                    </span>
                    <Icon className="text-brand size-5" aria-hidden />
                  </div>
                  <h3 className="mt-4 font-semibold">{title}</h3>
                  <p className="text-muted mt-1 text-sm">{text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="vendedores" className="px-4 py-20" aria-labelledby="vend">
          <div className="mx-auto max-w-6xl">
            <SectionHeading
              id="vend"
              eyebrow="Para vendedores e criadores"
              title="Tudo para vender sem cuidar de estoque"
              text="Escolha o que vender, divulgue do seu jeito e acompanhe o que realmente gera vendas."
            />
            <FeatureGrid items={sellerFeatures} columns="sm:grid-cols-2 lg:grid-cols-4" />
            <div className="mt-8 text-center">
              <CtaLink to="/cadastro">Criar conta de vendedor</CtaLink>
            </div>
          </div>
        </section>

        <section id="fornecedores" className="bg-surface-2/50 px-4 py-20" aria-labelledby="forn">
          <div className="mx-auto max-w-6xl">
            <SectionHeading
              id="forn"
              eyebrow="Para fornecedores"
              title="Mais canais de venda para o seu estoque"
              text="Seus produtos no catálogo de uma rede de vendedores, com pedidos e recebimento organizados."
            />
            <FeatureGrid items={supplierFeatures} columns="sm:grid-cols-2 lg:grid-cols-4" />
            <div className="mt-8 text-center">
              <CtaLink to="/cadastro?conta=fornecedor">Cadastrar como fornecedor</CtaLink>
            </div>
          </div>
        </section>

        <section id="academia" className="px-4 py-20" aria-labelledby="acad">
          <div className="border-border bg-surface mx-auto grid max-w-5xl items-center gap-8 rounded-2xl border p-8 md:grid-cols-2">
            <div>
              <p className="text-brand text-sm font-semibold">Academia TheSigns</p>
              <h2 id="acad" className="mt-2 text-2xl font-semibold tracking-tight">
                Aprenda a vender enquanto vende
              </h2>
              <p className="text-muted mt-3">
                Cursos dentro da plataforma, disponíveis para quem tem conta.
              </p>
            </div>
            <ul className="space-y-3">
              {academyPoints.map((p) => (
                <li key={p} className="flex gap-3 text-sm">
                  <GraduationCap className="text-brand mt-0.5 size-5 shrink-0" aria-hidden />
                  {p}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="planos" className="bg-surface-2/50 px-4 py-20" aria-labelledby="plan">
          <div className="mx-auto max-w-3xl">
            <SectionHeading
              id="plan"
              eyebrow="Planos"
              title="Comece sem mensalidade"
              text="A TheSigns ganha quando você vende pelo checkout."
            />
            <ul className="border-border bg-surface mt-10 space-y-4 rounded-2xl border p-6">
              {pricingPoints.map((p) => (
                <li key={p} className="flex gap-3 text-sm">
                  <Check className="text-success mt-0.5 size-5 shrink-0" aria-hidden />
                  {p}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="faq" className="px-4 py-20" aria-labelledby="duvidas">
          <div className="mx-auto max-w-3xl">
            <SectionHeading
              id="duvidas"
              eyebrow="Dúvidas frequentes"
              title="Perguntas e respostas"
              text="Não achou o que procurava? Crie sua conta e fale com a equipe pela Academia."
            />
            <div className="border-border divide-border bg-surface mt-10 divide-y rounded-2xl border">
              {faqs.map((f) => (
                <details key={f.question} className="group px-5 py-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                    {f.question}
                    <ChevronDown
                      className="text-muted size-4 shrink-0 transition-transform group-open:rotate-180"
                      aria-hidden
                    />
                  </summary>
                  <p className="text-muted mt-3 text-sm">{f.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="px-4 pb-20" aria-labelledby="final">
          <div className="bg-brand text-brand-fg mx-auto max-w-5xl rounded-2xl px-6 py-12 text-center">
            <h2 id="final" className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Pronto para começar?
            </h2>
            <p className="mx-auto mt-3 max-w-xl opacity-90">
              Crie sua conta, escolha os primeiros produtos e publique sua vitrine.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link
                to="/cadastro"
                className="bg-canvas text-fg inline-flex h-11 items-center rounded-lg px-5 text-sm font-semibold"
              >
                Criar conta grátis
              </Link>
              <Link
                to="/entrar"
                className="border-brand-fg/40 inline-flex h-11 items-center rounded-lg border px-5 text-sm font-semibold"
              >
                Já tenho conta
              </Link>
            </div>
          </div>
          <ul className="mx-auto mt-12 grid max-w-5xl gap-6 sm:grid-cols-3">
            {trustPoints.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-3">
                <Icon className="text-brand mt-0.5 size-5 shrink-0" aria-hidden />
                <div>
                  <p className="text-sm font-semibold">{title}</p>
                  <p className="text-muted text-sm">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-border text-muted border-t px-4 py-8 text-sm">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
          <p>© {new Date().getFullYear()} TheSigns</p>
          <nav className="flex gap-4" aria-label="Rodapé">
            <Link to="/entrar" className="hover:text-fg">
              Entrar
            </Link>
            <Link to="/cadastro" className="hover:text-fg">
              Criar conta
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
