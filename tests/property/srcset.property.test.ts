import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  buildSrcSet,
  DERIVATIVE_WIDTHS,
  derivativeWidthsFor,
  jpegFallbackWidthFor,
} from '@/lib/images/srcset';
import { planDerivatives } from '@/lib/images/derivatives';
import { assertProperty } from './config';

/**
 * The `srcset` builder and the width ladder.
 *
 * Design: Image Pipeline → Derivative generation and delivery.
 */

const imageArb = fc
  .record({
    width: fc.integer({ min: 1, max: 6000 }),
    height: fc.integer({ min: 1, max: 6000 }),
  })
  .map(({ width, height }) => ({
    productId: 'p_abcdefghij',
    image: {
      id: 'img_abcdefghij',
      width,
      height,
      alt: 'A photograph',
      derivativesReady: true,
    },
  }));

/** Arbitrary subsets of the ladder, plus deliberately hostile extras. */
const widthsArb = fc.oneof(
  fc.subarray([...DERIVATIVE_WIDTHS], { minLength: 0 }),
  fc.array(fc.integer({ min: 1, max: 9000 }), { maxLength: 8 }),
);

function parseSrcSet(srcset: string): { url: string; width: number }[] {
  if (srcset === '') return [];
  return srcset.split(', ').map((entry) => {
    const [url, descriptor] = entry.split(' ');
    return { url: url ?? '', width: Number.parseInt((descriptor ?? '').replace('w', ''), 10) };
  });
}

describe('Property 45: srcset never upscales and is never empty', () => {
  it('lists no width above the intrinsic width, and always at least one candidate', () => {
    assertProperty(
      fc.property(imageArb, widthsArb, (ref, widths) => {
        const entries = parseSrcSet(buildSrcSet(ref, widths));
        expect(entries.length).toBeGreaterThanOrEqual(1);
        for (const entry of entries) {
          expect(entry.width).toBeLessThanOrEqual(ref.image.width);
          expect(entry.width).toBeGreaterThanOrEqual(1);
          expect(entry.url).toContain(`${ref.image.id}-${String(entry.width)}.`);
        }
      }),
    );
  });

  it('holds for the default ladder as well as for a passed subset', () => {
    assertProperty(
      fc.property(imageArb, (ref) => {
        const entries = parseSrcSet(buildSrcSet(ref));
        expect(entries.length).toBeGreaterThanOrEqual(1);
        expect(Math.max(...entries.map((entry) => entry.width))).toBeLessThanOrEqual(
          ref.image.width,
        );
      }),
    );
  });

  it('emits strictly ascending, unique width descriptors', () => {
    assertProperty(
      fc.property(imageArb, widthsArb, (ref, widths) => {
        const values = parseSrcSet(buildSrcSet(ref, widths)).map((entry) => entry.width);
        expect([...new Set(values)]).toHaveLength(values.length);
        expect([...values].sort((a, b) => a - b)).toStrictEqual(values);
      }),
    );
  });

  it('advertises only widths the generator plans, so no candidate is a missing object', () => {
    assertProperty(
      fc.property(imageArb, (ref) => {
        const planned = new Set(
          planDerivatives(ref.productId, ref.image.id, ref.image.width, ['avif', 'webp', 'jpeg'])
            .filter((entry) => entry.format === 'webp')
            .map((entry) => entry.width),
        );
        for (const entry of parseSrcSet(buildSrcSet(ref))) {
          expect(planned.has(entry.width)).toBe(true);
        }
      }),
    );
  });

  it('never plans or offers a JPEG fallback wider than the original', () => {
    assertProperty(
      fc.property(fc.integer({ min: 1, max: 6000 }), (width) => {
        const fallback = jpegFallbackWidthFor(width);
        expect(fallback).toBeLessThanOrEqual(width);
        expect(derivativeWidthsFor(width)).toContain(fallback);
      }),
    );
  });
});
