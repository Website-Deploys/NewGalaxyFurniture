/**
 * The homepage hero's *editorial* visual — a real product photograph, when one exists.
 *
 * This is deliberately separate from `heroImageOf` in `hero-image.ts`. That function answers "what
 * site-wide hero photograph has the operator supplied in Settings?", and the answer is still "none"
 * (`site.heroImage` remains an unsupplied placeholder). This function answers a different question:
 * "of the real product photographs we already have, which one should carry the homepage hero as an
 * editorial visual until a dedicated showroom photograph is supplied?".
 *
 * Using a genuine product photograph here is honest — it is a real piece we make, shot by us — and
 * it is not a claim about a showroom or a fabricated scene. It also fabricates nothing: if the
 * catalogue has no published photograph, this returns `null` and the hero falls back to the
 * project's own hairline composition, exactly as before.
 *
 * The chosen image is resolved through the same `srcset`/`sizes`/`fallbackSrc` builders the rest of
 * the site uses, so the hero's `<img>` and the page's single preload hint resolve to the same
 * candidate rather than fetching two.
 */

import {
  buildSrcSet,
  derivativeWidthsFor,
  fallbackSrc,
  pickSizes,
  type ImageRef,
} from '@/lib/images/srcset';
import type { ImagePreloadHint } from '@/lib/images/preload';
import type { HeroImage } from '@/lib/site/hero-image';
import { primaryImageOf, type Product } from '@/schemas/product';

export interface HeroShowcase {
  /** A `HeroImage` the existing hero markup can render unchanged. */
  image: HeroImage & { srcset: string; sizes: string };
  /** The matching preload hint, so the page preloads exactly what the hero paints. */
  preload: ImagePreloadHint;
}

/** One image the hero carousel can paint: the same shape a slide's `<img>` needs. */
export interface HeroSlide {
  src: string;
  width: number;
  height: number;
  alt: string;
  lqip?: string;
  /** Absent for a single-resolution asset such as the supplied `hero.png`. */
  srcset?: string;
  sizes?: string;
}

/**
 * The widths a full-bleed hero photograph may advertise.
 *
 * The hero is rendered at up to 100vw, so — unlike a card — it is allowed the wide rungs of the
 * ladder. Capped at the image's own intrinsic width by `buildSrcSet`, so nothing is upscaled.
 */
function heroWidths(intrinsicWidth: number): number[] {
  return derivativeWidthsFor(intrinsicWidth);
}

/**
 * Choose the hero photograph from the published catalogue.
 *
 * The rule is intentionally simple and stable: the first published product (in the order the
 * catalogue already sorts them) that has a ready primary photograph. No ratings, popularity, or
 * invented ranking — just "a real photograph exists, use it". Returns `null` when none does.
 */
export function heroShowcaseFrom(products: readonly Product[]): HeroShowcase | null {
  for (const product of products) {
    const primary = primaryImageOf(product);
    if (primary === null) continue;

    const ref: ImageRef = { productId: product.id, image: primary };
    const src = fallbackSrc(ref);
    const srcset = buildSrcSet(ref, heroWidths(primary.width));
    const sizes = pickSizes('hero');

    const image: HeroImage & { srcset: string; sizes: string } = {
      src,
      width: primary.width,
      height: primary.height,
      // The photograph's own alt text — never invented here.
      alt: primary.alt,
      ...(primary.lqip === undefined ? {} : { lqip: primary.lqip }),
      supplied: true,
      srcset,
      sizes,
    };

    return {
      image,
      preload: { href: src, srcset, sizes },
    };
  }
  return null;
}

/**
 * The full set of product slides for the hero carousel — one image per published product.
 *
 * One image *per product*, its primary photograph, so the carousel shows variety rather than four
 * near-identical angles of the same sofa. Products with no ready photograph are skipped (never a
 * placeholder), and a `src` is never repeated, so a product that reuses another's asset cannot
 * produce a duplicate slide. The order is the catalogue's own order, which is stable.
 *
 * This fabricates nothing: every slide is a real product photograph the site already ships, resolved
 * through the same `srcset`/`sizes`/`fallbackSrc` builders as the cards. The page prepends the
 * operator's supplied `hero.png` as the first slide, so this returns only the product images.
 */
export function heroSlidesFrom(products: readonly Product[]): HeroSlide[] {
  const slides: HeroSlide[] = [];
  const seen = new Set<string>();

  for (const product of products) {
    const primary = primaryImageOf(product);
    if (primary === null) continue;

    const ref: ImageRef = { productId: product.id, image: primary };
    const src = fallbackSrc(ref);
    if (seen.has(src)) continue;
    seen.add(src);

    slides.push({
      src,
      width: primary.width,
      height: primary.height,
      // The photograph's own alt text — never invented here.
      alt: primary.alt,
      ...(primary.lqip === undefined ? {} : { lqip: primary.lqip }),
      srcset: buildSrcSet(ref, heroWidths(primary.width)),
      sizes: pickSizes('hero'),
    });
  }

  return slides;
}
