import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { Conversation } from './components/Conversation';
import {
  newTicketSchema,
  supportErrorMessage,
  ticketPrefill,
  ticketStatusLabel,
  type Ticket,
  type TicketMessage,
} from './support';

const mocks = vi.hoisted(() => ({ data: null as unknown, reply: vi.fn(), close: vi.fn() }));

vi.mock('./api', () => ({
  useTicket: () => ({ isPending: false, isError: false, data: mocks.data }),
  useReplyTicket: () => ({ mutate: mocks.reply, isPending: false, isError: false }),
  useCloseTicket: () => ({ mutate: mocks.close, isPending: false, isError: false }),
}));

const listing = '5b7c2a53-6d4e-4c1b-9f53-0b3f6f0f7a11';

describe('regras', () => {
  it('prefill só aceita categoria e ids válidos', () => {
    expect(
      ticketPrefill(new URLSearchParams(`categoria=report&anuncio=${listing}&pedido=x`)),
    ).toEqual({ category: 'report', listingId: listing, orderId: null });
    expect(ticketPrefill(new URLSearchParams('categoria=hack')).category).toBe('order');
  });

  it('denúncia precisa de alvo (código ou anúncio anexado)', () => {
    const base = {
      category: 'report',
      subject: 'Falsificado',
      body: 'Produto parece falso.',
      reported_code: '',
    };
    expect(newTicketSchema(false).safeParse(base).success).toBe(false);
    expect(newTicketSchema(true).safeParse(base).success).toBe(true);
    expect(newTicketSchema(false).safeParse({ ...base, reported_code: 'loja-x' }).success).toBe(
      true,
    );
    expect(
      newTicketSchema(false).safeParse({ ...base, category: 'order', body: 'curto' }).success,
    ).toBe(false);
  });

  it('rótulos por lado e erros', () => {
    expect(ticketStatusLabel('waiting_user', false)).toBe('Respondido — sua vez');
    expect(ticketStatusLabel('open', true)).toBe('Aguardando a equipe');
    expect(supportErrorMessage({ message: 'rate_limited' })).toMatch(/Aguarde/);
    expect(supportErrorMessage({ message: 'x' })).toMatch(/Tente de novo/);
  });
});

describe('conversa', () => {
  const ticket: Ticket = {
    id: listing,
    number: 12,
    category: 'order',
    subject: 'Pedido não chegou',
    status: 'waiting_user',
    organization_id: null,
    order_id: null,
    reported_listing_id: null,
    last_message_at: '2026-09-28T12:00:00Z',
    created_at: '2026-09-28T10:00:00Z',
    created_by: '7c9d3b64-7e5f-4d2c-8a64-1c4a7a1a8b22',
  };
  const messages: TicketMessage[] = [
    {
      id: 'a1b2c3d4-0000-4000-8000-000000000001',
      author_id: null,
      from_staff: false,
      body: 'Não recebi.',
      created_at: '2026-09-28T10:00:00Z',
    },
    {
      id: 'a1b2c3d4-0000-4000-8000-000000000002',
      author_id: null,
      from_staff: true,
      body: 'Estamos vendo.',
      created_at: '2026-09-28T12:00:00Z',
    },
  ];

  it('mostra quem falou, responde e encerra', async () => {
    mocks.data = { ticket, messages };
    render(
      <MemoryRouter>
        <Conversation ticketId={ticket.id} staff={false} backTo="/suporte" />
      </MemoryRouter>,
    );
    expect(screen.getByText('Chamado #12 · Pedido ou entrega')).toBeInTheDocument();
    expect(screen.getByText('Respondido — sua vez')).toBeInTheDocument();
    expect(screen.getByText(/Equipe TheSigns/)).toBeInTheDocument();
    expect(screen.getByText(/^Você/)).toBeInTheDocument();

    await userEvent.type(screen.getByRole('textbox', { name: 'Responder' }), '  Obrigado  ');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(mocks.reply.mock.calls[0]?.[0]).toBe('Obrigado');

    await userEvent.click(screen.getByRole('button', { name: /encerrar chamado/ }));
    expect(mocks.close).toHaveBeenCalled();
  });

  it('chamado encerrado: reabrir com mensagem, sem botão de encerrar', () => {
    mocks.data = { ticket: { ...ticket, status: 'closed' }, messages };
    render(
      <MemoryRouter>
        <Conversation ticketId={ticket.id} staff backTo="/admin/suporte" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('textbox', { name: 'Reabrir com uma mensagem' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Encerrar/ })).toBeNull();
  });
});
