/**
 * Money is always an integer number of cents (BRL). These helpers convert to
 * and from what people type, using string arithmetic so no float rounding
 * ever touches a stored value.
 */

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatBRL(cents: number): string {
  return brl.format(cents / 100);
}

/** Value for an input field: `4990` → `"49,90"`. */
export function centsToInput(cents: number | null | undefined): string {
  if (cents == null) return '';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Parses a non-negative BRL amount typed by a person into cents.
 * Accepts `49,90`, `1.234,56`, `R$ 10`, `1234.5` and `1234`. Returns null when
 * the text is not an unambiguous amount (more than 2 decimals, letters…).
 */
export function parseBRL(input: string): number | null {
  const text = input.replace(/^\s*R\$\s*/i, '').trim();
  if (!text) return null;

  let integer: string;
  let fraction = '';
  if (text.includes(',')) {
    // pt-BR: comma is the decimal separator, dots group thousands.
    const [int = '', frac = '', ...rest] = text.split(',');
    if (rest.length) return null;
    if (!/^\d{1,3}(\.\d{3})*$|^\d+$/.test(int)) return null;
    integer = int.replace(/\./g, '');
    fraction = frac;
  } else if (/^\d+\.\d{1,2}$/.test(text)) {
    // A single dot followed by 1–2 digits is a decimal point (e.g. pasted "49.9").
    [integer = '', fraction = ''] = text.split('.');
  } else if (/^\d{1,3}(\.\d{3})+$|^\d+$/.test(text)) {
    integer = text.replace(/\./g, '');
  } else {
    return null;
  }

  if (!/^\d{0,2}$/.test(fraction)) return null;
  const cents = Number(integer) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}
