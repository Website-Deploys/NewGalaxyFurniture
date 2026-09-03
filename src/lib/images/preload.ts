/**
 * The one image a page preloads.
 *
 * The design allows exactly one: "preloading more than one image" is on the prohibited list,
 * because two preloads compete for the same early bandwidth and the second delays the first — which
 * makes LCP worse than not preloading at all. So the hint is built from the same `srcset`/`sizes`
 * the element itself will carry, from the same builders, and the preload and the element therefore
 * resolve to the same candidate instead of fetching two.
 *
 * A page that has no contentful image (the policy pages, an empty catalogue) preloads nothing.
 * `null` from these functions is that case, and it is not a gap.
 *
 * Design: Performance Budgets → Techniques; Image Pipeline → Delivery budget on the page.
 * Requirements: 22.10.
 */

import { buildSrcSet, fallbackSrc, pickSizes } from '@/lib/images/srcset';
import { cardWidths } from '@/lib/images/staging';
import type { ProductImageValue } from '@/schemas/product';

export interface ImagePreloadHint {
  href: string;
  /** Omitted for a single-resolution asset such as the vector hero composition. */
  srcset?: string;
  sizes?: string;
}

/**
 * The hint for the first card of a grid — the largest contentful image on a listing page.
 *
 * Built from `cardWidths`, so the preloaded candidate is one a card is allowed to receive. A hint
 * that named the full-resolution derivative would fetch bytes the element then declines to use.
 */
export function cardImagePreload(
  productId: string,
  image: ProductImageValue | null,
): ImagePreloadHint | null {
  if (image === null) return null;
  const ref = { productId, image };
  return {
    href: fallbackSrc(ref),
    srcset: buildSrcSet(ref, cardWidths(image.width)),
    sizes: pickSizes('card'),
  };
}

/** The hero's hint. The composition is a vector, so it has one candidate and needs no `srcset`. */
export function heroImagePreload(src: string | null): ImagePreloadHint | null {
  if (src === null || src.trim() === '') return null;
  return { href: src };
}
