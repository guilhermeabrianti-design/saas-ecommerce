import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parseReview } from '../../../supabase/functions/_shared/reviews';
import { ReputationSummary, ReviewList } from './components/ReputationView';
import { RatingBadge, StarInput } from './components/Stars';
import {
  formatRating,
  metricRates,
  reviewCountLabel,
  reviewErrorMessage,
  type Reputation,
} from './reviews';

vi.mock('./api', () => ({
  useReplyReview: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

const token = '5b7c2a53-6d4e-4c1b-9f53-0b3f6f0f7a11';

describe('parser da Edge Function', () => {
  it('valida token, nota e comentário', () => {
    expect(parseReview({ token, rating: 5, comment: '  Ótimo  ' })).toEqual({
      token,
      rating: 5,
      comment: 'Ótimo',
    });
    expect(parseReview({ token, rating: 3, comment: '   ' })).toMatchObject({ comment: null });
    expect(parseReview({ token, rating: 0 })).toBeNull();
    expect(parseReview({ token, rating: 4.5 })).toBeNull();
    expect(parseReview({ token: 'x', rating: 5 })).toBeNull();
    expect(parseReview({ token, rating: 5, comment: 'x'.repeat(1001) })).toBeNull();
    expect(parseReview({ token, rating: 5, comment: 42 })).toBeNull();
  });
});

describe('métricas', () => {
  it('fornecedor: envio, cancelamento e tempo; só com pedidos suficientes', () => {
    expect(metricRates({ kind: 'supplier', metrics: { orders: 4, shipped: 4 } })).toEqual([]);
    const rates = metricRates({
      kind: 'supplier',
      metrics: { orders: 10, shipped: 9, cancelled: 1, avg_ship_hours: 30 },
    });
    expect(rates.map((r) => [r.label, r.value])).toEqual([
      ['Pedidos enviados', '90%'],
      ['Cancelamentos', '10%'],
      ['Tempo até o envio', '30 h'],
    ]);
    expect(
      metricRates({
        kind: 'supplier',
        metrics: { orders: 5, shipped: 5, cancelled: 0, avg_ship_hours: 72 },
      })[2]?.value,
    ).toBe('3 dias');
  });

  it('vendedor: entregues, enviados, cancelamentos', () => {
    expect(
      metricRates({
        kind: 'seller',
        metrics: { orders: 8, delivered: 6, shipped: 7, cancelled: 1 },
      }).map((r) => r.value),
    ).toEqual(['75%', '88%', '13%']);
  });

  it('formatação e erros', () => {
    expect(formatRating(4.5)).toBe('4,5');
    expect(formatRating(null)).toBe('—');
    expect(reviewCountLabel(1)).toBe('1 avaliação');
    expect(reviewErrorMessage({ code: 'review_not_allowed' })).toMatch(/enviado/);
    expect(reviewErrorMessage({ message: 'reviews.already_replied' })).toMatch(/resposta/);
  });
});

describe('componentes', () => {
  const rep: Reputation = {
    kind: 'seller',
    name: 'Loja V',
    can_reply: true,
    rating_avg: 4,
    rating_count: 2,
    distribution: { '1': 0, '2': 0, '3': 1, '4': 0, '5': 1 },
    metrics: { orders: 2, delivered: 2, shipped: 2, cancelled: 0 },
    reviews: [
      {
        id: token,
        source: 'buyer',
        reviewer_label: 'Maria',
        product_name: 'Camiseta',
        rating: 5,
        comment: 'Chegou rápido',
        reply: null,
        replied_at: null,
        created_at: '2026-09-28T12:00:00Z',
      },
    ],
  };

  it('resumo sem taxas com poucos pedidos; lista com resposta', () => {
    render(
      <>
        <ReputationSummary r={rep} />
        <ReviewList reviews={rep.reviews} canReply />
      </>,
    );
    expect(screen.getByText('4,0')).toBeInTheDocument();
    expect(screen.getByText(/a partir de 5 pedidos/)).toBeInTheDocument();
    expect(screen.getByText('Chegou rápido')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Responder' })).toBeInTheDocument();
  });

  it('selo some sem avaliações; escolha de estrelas', async () => {
    const { container } = render(<RatingBadge rating={{ rating_avg: null, rating_count: 0 }} />);
    expect(container).toBeEmptyDOMElement();
    const onChange = vi.fn();
    render(<StarInput value={0} onChange={onChange} />);
    await userEvent.click(screen.getByRole('radio', { name: '4 estrelas' }));
    expect(onChange).toHaveBeenCalledWith(4);
  });
});
