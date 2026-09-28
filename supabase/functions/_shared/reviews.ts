/**
 * Avaliação do comprador (Fase 28): validação do corpo de POST /review,
 * testada com vitest em `src/integrations/`. O banco valida de novo.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReviewInput {
  token: string;
  rating: number;
  comment: string | null;
}

export function parseReview(input: unknown): ReviewInput | null {
  if (!input || typeof input !== 'object') return null;
  const b = input as Record<string, unknown>;
  const token = typeof b.token === 'string' ? b.token.toLowerCase() : '';
  const rating = Number(b.rating);
  if (!UUID.test(token) || !Number.isInteger(rating) || rating < 1 || rating > 5) return null;
  if (b.comment != null && typeof b.comment !== 'string') return null;
  const comment = typeof b.comment === 'string' ? b.comment.trim() : '';
  if (comment.length > 1000) return null;
  return { token, rating, comment: comment || null };
}
