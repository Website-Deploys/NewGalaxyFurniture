import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { formatDisplayPhone, isE164, normalizeIndianPhone } from '@/lib/phone';

import { indianE164Arb, messyIndianPhoneArb } from './arbitraries';
import { assertProperty } from './config';

/**
 * Indian phone normalization.
 *
 * Design: Conversion → Lead capture.
 */

/** A 10-digit Indian subscriber number. */
const subscriberArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: 6, max: 9 }),
    fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 9, maxLength: 9 }),
  )
  .map(([lead, rest]) => `${lead}${rest.join('')}`);

/** Separator noise inserted at an arbitrary interior position. */
const withNoise = (value: string, noise: readonly string[], seeds: readonly number[]): string => {
  let out = value;
  noise.forEach((ch, index) => {
    const at = 1 + ((seeds[index] ?? 0) % Math.max(1, out.length - 1));
    out = `${out.slice(0, at)}${ch}${out.slice(at)}`;
  });
  return out;
};

describe('Property 42: Indian phone normalization is canonical and idempotent', () => {
  it('maps every accepted form of a number to one canonical value', () => {
    assertProperty(
      fc.property(
        subscriberArb,
        fc.array(fc.constantFrom(' ', '-', '(', ')', '.', '\u00a0'), { maxLength: 4 }),
        fc.array(fc.integer({ min: 0, max: 20 }), { minLength: 4, maxLength: 4 }),
        (subscriber, noise, seeds) => {
          const forms = [
            subscriber,
            `0${subscriber}`,
            `91${subscriber}`,
            `+91${subscriber}`,
            `+91 ${subscriber}`,
            `0091${subscriber}`,
          ].map((form) => withNoise(form, noise, seeds));

          const canonical = `+91${subscriber}`;
          for (const form of forms) {
            const result = normalizeIndianPhone(form);
            expect(result.ok).toBe(true);
            if (result.ok) {
              expect(result.e164).toBe(canonical);
              expect(isE164(result.e164)).toBe(true);
            }
          }
        },
      ),
    );
  });

  it('is idempotent', () => {
    assertProperty(
      fc.property(messyIndianPhoneArb, (input) => {
        const once = normalizeIndianPhone(input);
        expect(once.ok).toBe(true);
        if (once.ok) {
          const twice = normalizeIndianPhone(once.e164);
          expect(twice).toStrictEqual(once);
        }
      }),
    );
  });

  it('accepts an already-canonical number unchanged', () => {
    assertProperty(
      fc.property(indianE164Arb, (e164) => {
        expect(normalizeIndianPhone(e164)).toStrictEqual({ ok: true, e164 });
      }),
    );
  });

  it('returns a typed failure — never throws — for anything unnormalizable', () => {
    assertProperty(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 30 }),
          fc.string({ unit: 'grapheme', maxLength: 30 }),
          subscriberArb.map((s) => s.slice(0, 9)), // too short
          subscriberArb.map((s) => `${s}0`), // too long
          subscriberArb.map((s) => `+44${s}`), // wrong country
          subscriberArb.map((s) => `+91 0${s}`), // trunk prefix after +91
          subscriberArb.map((s) => `${s} ext 12`), // letters
          fc.constantFrom('', '   ', '+', '+91', '12345', '0000000000', '5123456789'),
        ),
        (input) => {
          const result = normalizeIndianPhone(input);
          if (result.ok) {
            // Only genuinely valid inputs may pass; assert the shape then.
            expect(isE164(result.e164)).toBe(true);
            expect(result.e164).toMatch(/^\+91[6-9]\d{9}$/);
          } else {
            expect(result.message.length).toBeGreaterThan(0);
          }
        },
      ),
    );
  });

  it('rejects a subscriber number that does not start 6–9', () => {
    assertProperty(
      fc.property(
        fc.tuple(
          fc.integer({ min: 0, max: 5 }),
          fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 9, maxLength: 9 }),
        ),
        ([lead, rest]) => {
          const invalid = `${lead}${rest.join('')}`;
          expect(normalizeIndianPhone(invalid).ok).toBe(false);
          expect(normalizeIndianPhone(`+91${invalid}`).ok).toBe(false);
        },
      ),
    );
  });

  it('formats for display without changing the digits', () => {
    assertProperty(
      fc.property(indianE164Arb, (e164) => {
        const display = formatDisplayPhone(e164);
        expect(display.replace(/\s/g, '')).toBe(e164);
        expect(display).toMatch(/^\+91 \d{5} \d{5}$/);
        const back = normalizeIndianPhone(display);
        expect(back).toStrictEqual({ ok: true, e164 });
      }),
    );
  });

  it('normalizes both business numbers to their stored form', () => {
    for (const [input, expected] of [
      ['9513443606', '+919513443606'],
      ['09513443606', '+919513443606'],
      ['+91 95134 43606', '+919513443606'],
      ['919513443606', '+919513443606'],
      ['8147083703', '+918147083703'],
      ['+91-81470-83703', '+918147083703'],
    ] as const) {
      expect(normalizeIndianPhone(input)).toStrictEqual({ ok: true, e164: expected });
    }
  });
});
