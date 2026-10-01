/**
 * Estoque por planilha (Fase 36): CSV com SKU e quantidade. Aceita o que o
 * Excel e os ERPs costumam exportar: separador ; ou , ou tab, cabeçalho
 * opcional (sku/código + quantidade/estoque/saldo), aspas e BOM.
 */

export const MAX_ROWS = 5000;

export interface StockCsvRow {
  sku: string;
  quantity: string;
}

export interface ParsedStockCsv {
  rows: StockCsvRow[];
  /** Linhas (1-based) ignoradas por estarem incompletas. */
  skipped: number[];
  error: string | null;
}

const SKU_HEADERS = ['sku', 'codigo', 'código', 'cod', 'referencia', 'referência', 'seller_sku'];
const QTY_HEADERS = ['quantidade', 'qtd', 'qtde', 'estoque', 'saldo', 'quantity', 'stock'];

const norm = (s: string) => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === sep && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

function detectSeparator(line: string): string {
  const counts = [';', ',', '\t'].map((s) => [s, line.split(s).length - 1] as const);
  return counts.sort((a, b) => b[1] - a[1])[0]![1] > 0 ? counts[0]![0] : ';';
}

/** Quantidade como o banco espera: inteiro ≥ 0 ("149", "149,0", "1.234"). */
export function normalizeQuantity(raw: string): string | null {
  const v = raw.trim().replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+$/.test(v)) return v.replace(/\./g, '');
  const m = /^(\d{1,9})([.,]0+)?$/.exec(v);
  return m ? m[1]! : null;
}

export function parseStockCsv(text: string): ParsedStockCsv {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd());
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) return { rows: [], skipped: [], error: 'A planilha está vazia.' };

  const sep = detectSeparator(lines[first]!);
  const head = splitLine(lines[first]!, sep).map(norm);
  let skuCol = head.findIndex((h) => SKU_HEADERS.includes(h));
  let qtyCol = head.findIndex((h) => QTY_HEADERS.includes(h));
  const hasHeader = skuCol >= 0 && qtyCol >= 0;
  if (!hasHeader) {
    skuCol = 0;
    qtyCol = 1;
  }

  const rows: StockCsvRow[] = [];
  const skipped: number[] = [];
  for (let i = hasHeader ? first + 1 : first; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const cells = splitLine(line, sep);
    const sku = cells[skuCol] ?? '';
    const quantity = normalizeQuantity(cells[qtyCol] ?? '');
    if (!sku || quantity === null) {
      skipped.push(i + 1);
      continue;
    }
    rows.push({ sku, quantity });
  }
  if (rows.length > MAX_ROWS) {
    return { rows: [], skipped, error: `Máximo de ${MAX_ROWS} linhas por planilha.` };
  }
  if (rows.length === 0) {
    return {
      rows,
      skipped,
      error: 'Nenhuma linha válida. Use duas colunas: SKU e quantidade (ex.: CANECA;149).',
    };
  }
  return { rows, skipped, error: null };
}

const csvCell = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Modelo com o estoque atual (separador ; para abrir direto no Excel em português). */
export function stockTemplateCsv(items: { sku: string; on_hand: number }[]): string {
  return ['sku;quantidade', ...items.map((i) => `${csvCell(i.sku)};${i.on_hand}`)].join('\r\n');
}

export interface StockSyncSummary {
  updated: number;
  unchanged: number;
  unknown_count: number;
  unknown: string[];
  invalid: string[];
  clamped: string[];
}

export function describeSummary(s: StockSyncSummary): string {
  const parts = [`${s.updated} atualizado(s)`, `${s.unchanged} sem mudança`];
  if (s.unknown_count) parts.push(`${s.unknown_count} SKU(s) não encontrado(s) aqui`);
  if (s.clamped.length) parts.push(`${s.clamped.length} abaixo do reservado por pedidos`);
  if (s.invalid.length) parts.push(`${s.invalid.length} com quantidade inválida`);
  return parts.join(' · ');
}
