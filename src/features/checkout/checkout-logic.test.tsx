import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { orderStatusLabel } from '@/features/orders/schemas';
import {
  CheckoutError,
  buyerSchema,
  checkoutErrorMessage,
  checkoutLink,
  commissionSourceLabel,
  emptyBuyer,
  maxQuantity,
  offerSchema,
  selection,
  shouldPoll,
  statusHeadline,
  toBuyerPayload,
  toPaymentPayload,
  type CheckoutOffer,
  type CheckoutOrderStatus,
} from './checkout';
import { CheckoutPaymentSection } from './components/CheckoutPaymentSection';
import { CheckoutStatusPage } from './pages/CheckoutStatusPage';

const mocks = vi.hoisted(() => ({ status: null as unknown }));

vi.mock('./api', () => ({
  useCheckoutOrderStatus: () => ({ isPending: false, isError: false, data: mocks.status }),
  useSubmitReview: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

const validBuyer = {
  ...emptyBuyer,
  customer_name: 'Maria da Silva',
  customer_email: 'Maria@Example.com',
  customer_phone: '(11) 98765-4321',
  customer_document: '123.456.789-09',
  ship_postal_code: '01310-100',
  ship_street: 'Av. Paulista',
  ship_number: '1000',
  ship_district: 'Bela Vista',
  ship_city: 'São Paulo',
  ship_state: 'SP' as const,
};

const baseStatus: CheckoutOrderStatus = {
  order_number: 7,
  store_name: 'Loja V',
  product_name: 'Camiseta',
  total_cents: 5990,
  payment_status: 'pending',
  order_status: 'pending',
  method: 'pix',
  pix_qr_code: '00020126580014br.gov.bcb.pix',
  pix_qr_base64: 'iVBORw0KGgo=',
  boleto_url: null,
  expires_at: '2026-09-28T13:00:00Z',
  refund_pending: false,
  tracking: null,
  can_review: false,
};

describe('comprador', () => {
  it('valida o formulário e envia só dígitos', () => {
    const parsed = buyerSchema.parse(validBuyer);
    expect(toBuyerPayload(parsed)).toMatchObject({
      customer_email: 'maria@example.com',
      customer_phone: '11987654321',
      customer_document: '12345678909',
      ship_postal_code: '01310100',
    });
    const errors = buyerSchema
      .safeParse({
        ...validBuyer,
        customer_document: '111.111.111-11',
        customer_phone: '123',
        ship_postal_code: '0131',
      })
      .error?.issues.map((i) => i.path[0]);
    expect(errors).toEqual(['customer_phone', 'customer_document', 'ship_postal_code']);
  });

  it('do Brick só vão meio, token, parcelas e emissor (nunca valor)', () => {
    expect(
      toPaymentPayload({
        payment_method_id: 'master',
        token: 'tok',
        installments: '3',
        issuer_id: 25,
        transaction_amount: 0.01,
        payer: { email: 'x@y.z' },
      }),
    ).toEqual({ payment_method_id: 'master', token: 'tok', installments: 3, issuer_id: '25' });
    expect(toPaymentPayload({ payment_method_id: 'pix', payer: {} })).toEqual({
      payment_method_id: 'pix',
    });
  });
});

describe('oferta', () => {
  const offer: CheckoutOffer = offerSchema.parse({
    offer: {
      product_id: '5b7c2a53-6d4e-4c1b-9f53-0b3f6f0f7a11',
      name: 'Camiseta',
      description: '',
      brand: null,
      store_name: 'Loja V',
      price_cents: 5990,
      has_variants: true,
      available: null,
      variants: [
        {
          variant_id: '7c9d3b64-7e5f-4d2c-8a64-1c4a7a1a8b22',
          attributes: { Cor: 'Azul' },
          price_cents: 6490,
          available: 3,
        },
      ],
      images: [],
    },
    payments: { configured: false },
  });

  it('preço e saldo seguem a variação; quantidade até 10 e até o saldo', () => {
    expect(selection(offer.offer, '7c9d3b64-7e5f-4d2c-8a64-1c4a7a1a8b22')).toMatchObject({
      price_cents: 6490,
      available: 3,
    });
    expect(selection(offer.offer, null)).toMatchObject({ price_cents: null, available: 0 });
    expect(selection({ ...offer.offer, has_variants: false, available: 50 }, null)).toMatchObject({
      price_cents: 5990,
      available: 50,
    });
    expect(maxQuantity(3)).toBe(3);
    expect(maxQuantity(50)).toBe(10);
    expect(maxQuantity(null)).toBe(0);
  });

  it('chave pública só vem quando os pagamentos estão configurados', () => {
    expect(offerSchema.safeParse({ ...offer, payments: { configured: true } }).success).toBe(false);
  });
});

describe('situação', () => {
  it('manchete, consulta periódica e rótulo do pedido', () => {
    expect(statusHeadline(baseStatus)).toBe('Pedido reservado até o pagamento.');
    expect(statusHeadline({ ...baseStatus, method: 'card' })).toMatch(/em análise/);
    expect(
      statusHeadline({ ...baseStatus, payment_status: 'approved', order_status: 'confirmed' }),
    ).toMatch(/em separação/);
    expect(
      statusHeadline({ ...baseStatus, payment_status: 'approved', order_status: 'cancelled' }),
    ).toMatch(/estornado/);
    expect(statusHeadline({ ...baseStatus, payment_status: 'rejected' })).toBe(
      'Pagamento recusado',
    );

    expect(shouldPoll(baseStatus)).toBe(true);
    expect(shouldPoll({ ...baseStatus, payment_status: 'approved' })).toBe(false);
    expect(shouldPoll({ ...baseStatus, payment_status: 'approved', refund_pending: true })).toBe(
      true,
    );
    expect(shouldPoll(null)).toBe(false);

    expect(orderStatusLabel('pending', 'checkout')).toBe('Aguardando pagamento');
    expect(orderStatusLabel('pending', 'manual')).toBe('Pendente');
  });

  it('mensagens de erro por código e campo', () => {
    expect(checkoutErrorMessage(new CheckoutError('out_of_stock'))).toMatch(/Estoque insuficiente/);
    expect(checkoutErrorMessage(new CheckoutError('invalid_body', 'customer_document'))).toBe(
      'Confira o campo CPF.',
    );
    expect(checkoutErrorMessage(new Error('x'))).toMatch(/Tente de novo/);
    expect(checkoutLink('https://app.thesigns.com.br', 'abc')).toBe(
      'https://app.thesigns.com.br/c/abc',
    );
    expect(commissionSourceLabel('live_campaign')).toBe('campanha de live');
    expect(commissionSourceLabel('nova')).toBe('nova');
  });
});

function renderStatus() {
  return render(
    <MemoryRouter initialEntries={['/c/pedido/11111111-2222-4333-8444-555555555555']}>
      <Routes>
        <Route path="/c/pedido/:token" element={<CheckoutStatusPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('telas', () => {
  it('PIX pendente mostra QR Code e código para copiar', () => {
    mocks.status = baseStatus;
    renderStatus();
    expect(
      screen.getByRole('heading', { name: 'Pedido reservado até o pagamento.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'QR Code do Pix' })).toHaveAttribute(
      'src',
      'data:image/png;base64,iVBORw0KGgo=',
    );
    expect(screen.getByRole('textbox', { name: 'Código Pix' })).toHaveValue(
      '00020126580014br.gov.bcb.pix',
    );
  });

  it('boleto abre em nova aba; enviado mostra o rastreio', () => {
    mocks.status = {
      ...baseStatus,
      method: 'boleto',
      pix_qr_code: null,
      pix_qr_base64: null,
      boleto_url: 'https://www.mercadopago.com.br/boleto/1',
    };
    const { unmount } = renderStatus();
    expect(screen.getByRole('link', { name: /Abrir boleto/ })).toHaveAttribute('target', '_blank');
    unmount();

    mocks.status = {
      ...baseStatus,
      payment_status: 'approved',
      order_status: 'shipped',
      tracking: [{ carrier: 'Correios', code: 'AA123456789BR' }],
    };
    renderStatus();
    expect(screen.getByRole('heading', { name: 'Pedido enviado.' })).toBeInTheDocument();
    expect(screen.getByText('AA123456789BR')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'QR Code do Pix' })).not.toBeInTheDocument();
  });

  it('pedido inexistente', () => {
    mocks.status = null;
    renderStatus();
    expect(screen.getByText(/Pedido não encontrado/)).toBeInTheDocument();
  });

  it('vendedor vê pagamento e comissão do pedido', () => {
    render(
      <CheckoutPaymentSection
        info={{
          payment: {
            method: 'card',
            status: 'approved',
            amount_cents: 5990,
            expires_at: null,
            needs_refund: false,
            approved_at: '2026-09-28T12:00:00Z',
          },
          split: {
            seller_commission_bps: 1500,
            seller_commission_source: 'default',
            seller_commission_cents: 899,
            settled_at: '2026-09-28T12:00:00Z',
          },
        }}
      />,
    );
    expect(screen.getByText('Pagamento aprovado')).toBeInTheDocument();
    expect(screen.getByText(/Sua comissão \(15%, comissão padrão\)/)).toBeInTheDocument();
    expect(screen.getByText('R$ 8,99')).toBeInTheDocument();
  });
});
