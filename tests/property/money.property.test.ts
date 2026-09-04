import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  formatINR,
  formatPriceOrLabel,
  parseINR,
  PRICE_ON_ENQUIRY_LABEL,
  priceBandOf,
} from '@/lib/money';

import { inrAmountArb } from './arbitraries';
import { assertProperty } from './config';

/**
 * INR formatting.
 *
 * Design: Catalogue → Filters; Data Models → Canonical product schema.
 */

/** Indian grouping: `123`, or `1,234`, or `12,34,567` — last group of three, then twos. */
const INDIAN_GROUPING = /^₹(\d{1,3}|\d{1,2}(?:,\d{2})*,\d{3})$/;

describe('Property 44: INR formatting uses Indian grouping and round-trips', () => {
  it('formats with the ₹ symbol and Indian digit grouping', () => {
    assertProperty(
      fc.property(inrAmountArb, (amount) => {
        const formatted = formatINR(amount);
        expect(formatted.startsWith('₹')).toBe(true);
        expect(formatted).toMatch(INDIAN_GROUPING);
        // No separator may change a digit.
        expect(formatted.replace(/[₹,]/g, '')).toBe(String(amount));
        // No fractional digits, ever.
        expect(formatted).not.toContain('.');
      }),
    );
  });

  it('round-trips through parseINR', () => {
    assertProperty(
      fc.property(inrAmountArb, (amount) => {
        expect(parseINR(formatINR(amount))).toBe(amount);
      }),
    );
  });

  it('accepts what an operator types', () => {
    assertProperty(
      fc.property(inrAmountArb, (amount) => {
        expect(parseINR(String(amount))).toBe(amount);
        expect(parseINR(` ₹ ${formatINR(amount).slice(1)} `)).toBe(amount);
      }),
    );
  });

  it('rejects text that is not a single amount', () => {
    assertProperty(
      fc.property(
        fc.oneof(
          fc.constantFrom('', '₹', 'free', '1.5', '12,00,0a0', '1e5', '--5', '₹1,000.50'),
          fc
            .string({ maxLength: 12 })
            .filter((s) => !/^[\s\u00a0₹,\d-]*\d[\s\u00a0₹,\d-]*$/.test(s)),
        ),
        (text) => {
          expect(parseINR(text)).toBeNull();
        },
      ),
    );
  });

  it('renders the shared label instead of an amount for price-on-enquiry', () => {
    assertProperty(
      fc.property(inrAmountArb, (amount) => {
        expect(formatPriceOrLabel(null, true)).toBe(PRICE_ON_ENQUIRY_LABEL);
        expect(formatPriceOrLabel(amount, true)).toBe(PRICE_ON_ENQUIRY_LABEL);
        expect(formatPriceOrLabel(null, false)).toBe(PRICE_ON_ENQUIRY_LABEL);
        expect(formatPriceOrLabel(amount, false)).toBe(formatINR(amount));
      }),
    );
  });

  it('names the known lakh and crore boundaries exactly', () => {
    expect(formatINR(100_000)).toBe('₹1,00,000');
    expect(formatINR(10_000_000)).toBe('₹1,00,00,000');
    expect(formatINR(42_000)).toBe('₹42,000');
    expect(formatINR(999)).toBe('₹999');
    expect(formatINR(1000)).toBe('₹1,000');
    expect(formatINR(0)).toBe('₹0');
  });
});

describe('price bands', () => {
  it('assigns every price to exactly one band, and no band to price-on-enquiry', () => {
    assertProperty(
      fc.property(inrAmountArb, (amount) => {
        const band = priceBandOf(amount);
        expect(band).not.toBeNull();
        expect(priceBandOf(null)).toBeNull();

        const expected =
          amount < 25_000
            ? 'under25k'
            : amount < 50_000
              ? '25k-50k'
              : amount < 100_000
                ? '50k-1L'
                : '1L+';
        expect(band).toBe(expected);
      }),
    );
  });

  it('is monotone: a higher price never falls in a lower band', () => {
    const order = ['under25k', '25k-50k', '50k-1L', '1L+'];
    assertProperty(
      fc.property(inrAmountArb, inrAmountArb, (a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        const lowBand = order.indexOf(priceBandOf(low) ?? '');
        const highBand = order.indexOf(priceBandOf(high) ?? '');
        expect(lowBand).toBeLessThanOrEqual(highBand);
      }),
    );
  });
});
