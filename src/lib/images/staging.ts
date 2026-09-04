/**
 * The delivery staging rules from the design's "Delivery budget on the page" table, as pure
 * functions rather than as decisions repeated at each surface.
 *
 * The table it implements:
 *
 * | Surface | Eager | Lazy |
 * |---|---|---|
 * | Product card | 1 image at card width | second image on hover/focus intent only |
 * | PDP | primary only, `loading="eager"` + `fetchpriority="high"` | rail at 96 px, rest on navigation |
 * | Category / collection grid | first 6 cards | remainder lazy with `content-visibility: auto` |
 * | Gallery page | first row | rest lazy, reserved aspect boxes |
 *
 * Three rules are stated once here because each of them was previously a per-call-site choice, and
 * two of the three were being made wrongly:
 *
 * 1. **`eager` and `priority` are different things.** `loading="eager"` says "do not defer this
 *    fetch"; `fetchpriority="high"` says "fetch this *before* the others". The design gives
 *    `fetchpriority="high"` to the LCP image alone, and the prohibition on preloading more than one
 *    image is the same rule from the other side: six high-priority images is six images competing
 *    for the same early bandwidth, which delays the one that decides LCP. So the first six cards of
 *    a grid are eager and exactly one image on the page is priority.
 * 2. **A card never receives a full-resolution image** (Requirement 22.9). A card is rendered at
 *    22–92 vw, so the top of the derivative ladder is bytes no card can use — and the 2000 px rung
 *    is the zoom-only derivative that `robots.txt` disallows. `cardWidths` caps the candidates and
 *    drops the image's own intrinsic width, so "full resolution to a card" is not reachable from
 *    the markup rather than merely discouraged.
 * 3. **Everything that is not the priority image is `loading="lazy"` + `decoding="async"`.** One
 *    function returns the attribute triple, so a surface cannot emit `lazy` without `async` or
 *    `eager` without deciding about priority.
 *
 * Design: Image Pipeline → Delivery budget on the page; Performance Budgets → Techniques.
 * Requirements: 15.17, 22.9, 22.10.
 */

import { derivativeWidthsFor } from '@/lib/images/srcset';

/** The number of catalogue cards above the fold on the widest supported grid. */
export const EAGER_CARDS = 6;

/**
 * The widest derivative a card may advertise.
 *
 * A card is at most 22 vw from 1440 px up, so 1280 px covers a 2× screen at that width with room
 * to spare, and it is one rung below the 2000 px zoom derivative in every case.
 */
export const CARD_MAX_WIDTH = 1280;

/** Requirement 15.17: the first six cards of a grid are eager, the remainder are lazy. */
export function isEagerCard(position: number): boolean {
  return Number.isFinite(position) && position >= 0 && position < EAGER_CARDS;
}

/**
 * The `srcset` candidate widths for a card.
 *
 * Never above `CARD_MAX_WIDTH`, and never the image's own intrinsic width — that is what "full
 * resolution" means, and it is the one candidate a card must not offer. Never empty: an image
 * narrower than the smallest rung falls back to that rung, because an empty `srcset` sends the
 * browser to `src` with no width information at all.
 */
export function cardWidths(intrinsicWidth: number): number[] {
  const ladder = derivativeWidthsFor(intrinsicWidth);
  const usable = ladder.filter((width) => width <= CARD_MAX_WIDTH && width < intrinsicWidth);
  if (usable.length > 0) return usable;
  const smallest = ladder[0];
  return smallest === undefined ? [1] : [smallest];
}

export interface LoadingAttributes {
  loading: 'eager' | 'lazy';
  decoding: 'sync' | 'async';
  fetchpriority: 'high' | 'auto';
}

/**
 * The loading attribute triple for one image.
 *
 * `priority` is the page's single largest contentful image. `eager` is "above the fold, fetch it
 * now, but do not jump the queue". Everything else defers.
 *
 * `decoding="sync"` accompanies `priority` only: it keeps the LCP element from being painted a
 * frame late, and asking for a synchronous decode of a below-fold image would block the main thread
 * for an image nobody is looking at.
 */
export function loadingAttributes(
  options: { priority?: boolean; eager?: boolean } = {},
): LoadingAttributes {
  if (options.priority === true) {
    return { loading: 'eager', decoding: 'sync', fetchpriority: 'high' };
  }
  if (options.eager === true) {
    return { loading: 'eager', decoding: 'async', fetchpriority: 'auto' };
  }
  return { loading: 'lazy', decoding: 'async', fetchpriority: 'auto' };
}
