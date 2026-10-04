import { str } from './common.ts';
import type { MlCategorySuggestion, PublishData } from './mlpublish.ts';

/**
 * Peças comuns da publicação na Shopee e na TikTok Shop (Fase 44): árvore
 * de categorias, características das variações e textos. Código puro,
 * testado com vitest em `src/integrations/`.
 */

export interface CategoryNode {
  id: string;
  parent: string | null;
  name: string;
  leaf: boolean;
}

/** "Moda › Roupas › Camisetas" (até 6 níveis, sem laço). */
export function categoryPath(nodes: Map<string, CategoryNode>, id: string): string {
  const names: string[] = [];
  let current = nodes.get(id);
  const seen = new Set<string>();
  while (current && !seen.has(current.id) && names.length < 6) {
    seen.add(current.id);
    names.unshift(current.name);
    current = current.parent ? nodes.get(current.parent) : undefined;
  }
  return names.join(' › ').slice(0, 400);
}

/** Sugestões a partir de ids recomendados: só categorias finais, com o caminho. */
export function suggestionsFromIds(
  nodes: Map<string, CategoryNode>,
  ids: string[],
): MlCategorySuggestion[] {
  const out: MlCategorySuggestion[] = [];
  for (const id of ids) {
    const node = nodes.get(id);
    if (!node || !node.leaf || out.some((s) => s.category_id === id)) continue;
    out.push({ category_id: id, category_name: categoryPath(nodes, id), domain_name: '' });
  }
  return out.slice(0, 8);
}

/** Busca por palavra na árvore (quando o marketplace não recomenda nada). */
export function searchCategories(
  nodes: Map<string, CategoryNode>,
  q: string,
): MlCategorySuggestion[] {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const words = norm(q)
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  if (words.length === 0) return [];
  const scored: { id: string; score: number }[] = [];
  for (const node of nodes.values()) {
    if (!node.leaf) continue;
    const name = norm(node.name);
    const score = words.filter((w) => name.includes(w)).length;
    if (score > 0) scored.push({ id: node.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return suggestionsFromIds(
    nodes,
    scored.slice(0, 8).map((s) => s.id),
  );
}

/** Texto puro, sem HTML, com limite. */
export function plainText(text: string, max: number): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

export interface Tiers {
  /** Características na ordem ("Cor", "Tamanho"). */
  names: string[];
  /** Opções de cada característica, na ordem em que aparecem. */
  options: string[][];
  /** Índices das opções de cada variação (mesma ordem de `data.variants`). */
  indexes: number[][];
}

/**
 * Características das variações ativas → níveis de variação. Erros: mais
 * características que o marketplace aceita, variação sem valor numa delas
 * ou duas variações com a mesma combinação.
 */
export function variantTiers(
  data: PublishData,
  maxTiers: number,
  marketplace: string,
): { ok: true; tiers: Tiers } | { ok: false; errors: string[] } {
  const names: string[] = [];
  for (const v of data.variants)
    for (const k of Object.keys(v.attributes)) if (!names.includes(k)) names.push(k);
  const errors: string[] = [];
  if (names.length === 0) errors.push('As variações precisam de características (ex.: Cor).');
  if (names.length > maxTiers)
    errors.push(
      `${marketplace} aceita até ${maxTiers} características de variação (este produto tem ${names.length}: ${names.join(', ')}).`,
    );
  if (errors.length) return { ok: false, errors };

  const options: string[][] = names.map(() => []);
  const indexes: number[][] = [];
  const combos = new Set<string>();
  for (const v of data.variants) {
    const idx: number[] = [];
    for (const [i, name] of names.entries()) {
      const value = str(v.attributes[name]);
      if (!value) {
        errors.push(`A variação ${v.sku} não tem "${name}".`);
        continue;
      }
      let at = options[i]!.indexOf(value);
      if (at < 0) {
        options[i]!.push(value);
        at = options[i]!.length - 1;
      }
      idx.push(at);
    }
    const key = idx.join(':');
    if (combos.has(key)) errors.push(`Duas variações têm a mesma combinação (${v.sku}).`);
    combos.add(key);
    indexes.push(idx);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, tiers: { names, options, indexes } };
}

/** Obrigatórios da categoria ainda sem valor salvo. */
export function missingAttributes(
  required: { id: string; name: string }[],
  saved: { id: string }[],
): string[] {
  const have = new Set(saved.map((a) => a.id));
  return required.filter((a) => !have.has(a.id)).map((a) => a.name);
}
