/**
 * INR formatting and price bands.
 *
 * Grouping is implemented rather than delegated to `Intl`: the same string must be
 * produced at build time in Node, inside the Worker, and in the browser, and ICU
 * data availability differs across those three. The Indian grouping rule — last
 * three digits, then groups of two — is stable and short enough to own.
 *
 * `PRICE_ON_ENQUIRY_LABEL` is exported so that every surface says the same thing.
 * A product with no price shows this label and never a number (requirement 1.7).
 *
 * Design: Catalogue → Filters; Data Models → Canonical product schema.
 * Requirements: 1.6, 1.7, 3.2, 3.9.
 */

export const PRICE_ON_ENQUIRY_LABEL = 'Price on enquiry';

/** The rupee sign. */
export const INR_SYMBOL = '₹';

/**
 * `100000` → `₹1,00,000`. No fractional digits: the catalogue prices in whole
 * rupees, and a trailing `.00` on a furniture price reads like a supermarket.
 */
export function formatINR(amount: number): string {
  if (!Number.isFinite(amount)) return PRICE_ON_ENQUIRY_LABEL;

  const rounded = Math.round(Math.abs(amount));
  const sign = amount < 0 ? '-' : '';
  return `${sign}${INR_SYMBOL}${groupIndian(String(rounded))}`;
}

/** Last three digits, then groups of two: `10000000` → `1,00,00,000`. */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${grouped},${last3}`;
}

/**
 * The inverse of `formatINR`: accepts the formatted string, and also what an
 * operator types into an admin price field (`42,000`, `₹ 42000`, `42000`).
 * Returns `null` for anything that is not a single rupee amount, so the caller
 * reports a field error rather than storing `NaN`.
 */
export function parseINR(text: string): number | null {
  const cleaned = text
    .replace(new RegExp(INR_SYMBOL, 'g'), '')
    .replace(/[\s\u00a0]/g, '')
    .replace(/,/g, '');
  if (!/^-?\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isSafeInteger(value) ? value : null;
}

/** The five required presets. `any` is the neutral state, not a band. */
export type PriceBand = 'under25k' | '25k-50k' | '50k-1L' | '1L+';
export type PriceBandFilter = 'any' | PriceBand;

/** Half-open bounds, so the four bands partition the positive numbers exactly. */
export const PRICE_BANDS: readonly { band: PriceBand; label: string; min: number; max: number }[] =
  [
    { band: 'under25k', label: 'Under ₹25,000', min: 0, max: 25_000 },
    { band: '25k-50k', label: '₹25,000–₹50,000', min: 25_000, max: 50_000 },
    { band: '50k-1L', label: '₹50,000–₹1,00,000', min: 50_000, max: 100_000 },
    { band: '1L+', label: '₹1,00,000+', min: 100_000, max: Number.POSITIVE_INFINITY },
  ];

/**
 * The band a price falls in, or `null` when there is no price.
 *
 * `null` is what excludes price-on-enquiry products from every banded filter while
 * keeping them under "Any" (requirement 3.9) — the filter compares bands, so a
 * product with no band matches no band.
 */
export function priceBandOf(price: number | null): PriceBand | null {
  if (price === null || !Number.isFinite(price)) return null;
  for (const entry of PRICE_BANDS) {
    if (price >= entry.min && price < entry.max) return entry.band;
  }
  return null;
}

/** The operator-facing label for a band, for the filter chips. */
export function priceBandLabel(band: PriceBandFilter): string {
  if (band === 'any') return 'Any';
  return PRICE_BANDS.find((entry) => entry.band === band)?.label ?? 'Any';
}

/** What a card or PDP renders for a product's price. */
export function formatPriceOrLabel(price: number | null, priceOnEnquiry: boolean): string {
  if (priceOnEnquiry || price === null) return PRICE_ON_ENQUIRY_LABEL;
  return formatINR(price);
}
