/**
 * Tipos comuns do envio de estoque e das chamadas aos marketplaces. `fetch`
 * é injetado para testar sem rede. Toda falha vira `StockPushError`
 * (mensagem curta, sem segredos) e o worker registra com backoff.
 */

export class StockPushError extends Error {}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
