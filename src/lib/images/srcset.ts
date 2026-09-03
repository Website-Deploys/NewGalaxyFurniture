/**
 * Derivative widths, object keys, URLs, `srcset` and `sizes`.
 *
 * The width ladder is used by **both** generation and markup, from this one place. That is
 * what makes "the `srcset` never advertises a derivative that was not written" true rather
 * than hoped for: the planner and the builder call the same function, so they cannot drift.
 *
 * Two rules the property test pins down (Property 45):
 *
 * - **Never upscale.** A width above the original's intrinsic width is dropped. Serving an
 *   upscaled derivative costs bytes to deliver a blurrier image.
 * - **Never empty.** If the original is narrower than the smallest ladder width — which the
 *   800 px upload minimum prevents in practice, but the type does not — the ladder falls
 *   back to the image's own width, so there is always at least one candidate. An empty
 *   `srcset` makes the browser fall back to `src` with no width information, which
 *   reintroduces exactly the layout shift the intrinsic dimensions exist to prevent.
 *
 * Design: Image Pipeline → Derivative generation and delivery, Delivery budget on the page.
 * Requirements: 15.8, 15.9, 15.12, 22.9.
 */

import type { DerivativeFormatValue, ProductImageValue } from '@/schemas/product';

/** The design's ladder. */
export const DERIVATIVE_WIDTHS: readonly number[] = [320, 480, 640, 960, 1280, 1600, 2000];

/** The one width that also gets a JPEG, as a universal fallback. */
export const JPEG_FALLBACK_WIDTH = 1280;

/** `public, max-age=31536000, immutable` — keys are content-addressed by image id. */
export const IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * The widths to generate and to advertise for an image of this intrinsic width.
 *
 * Total for every positive integer, and never returns an empty array.
 */
export function derivativeWidthsFor(intrinsicWidth: number): number[] {
  if (!Number.isFinite(intrinsicWidth) || intrinsicWidth < 1) return [1];
  const width = Math.floor(intrinsicWidth);
  const ladder = DERIVATIVE_WIDTHS.filter((candidate) => candidate <= width);
  return ladder.length > 0 ? ladder : [width];
}

/**
 * The width the JPEG fallback is written at: 1280 when the original reaches it, otherwise
 * the widest derivative that exists. "One JPEG at 1280" cannot be taken literally for an
 * 800 px original without upscaling, and a fallback that is missing for small images is
 * worse than one at a smaller width.
 */
export function jpegFallbackWidthFor(intrinsicWidth: number): number {
  const widths = derivativeWidthsFor(intrinsicWidth);
  if (widths.includes(JPEG_FALLBACK_WIDTH)) return JPEG_FALLBACK_WIDTH;
  return widths[widths.length - 1] ?? 1;
}

/* -------------------------------------------------------------------------- */
/* Keys and URLs                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The R2 key of the stored original: `products/{productId}/{imageId}/original.{ext}`.
 *
 * Generated here and only here, from a product id and a server-generated image id. No
 * component comes from the client (Requirement 15.7).
 */
export function originalKey(productId: string, imageId: string, ext: string): string {
  return `products/${productId}/${imageId}/original.${ext}`;
}

export function derivativeKey(
  productId: string,
  imageId: string,
  width: number,
  format: DerivativeFormatValue,
): string {
  return `products/${productId}/${imageId}/${width}.${format}`;
}

/** The `deleted/` prefix a soft-deleted object is moved under, recoverable for 30 days. */
export const DELETED_PREFIX = 'deleted/';

export function deletedKey(key: string): string {
  return `${DELETED_PREFIX}${key}`;
}

/** Every object belonging to one image — used by the soft delete. */
export function imagePrefix(productId: string, imageId: string): string {
  return `products/${productId}/${imageId}/`;
}

/**
 * The public URL for one derivative: `/img/{productId}/{imageId}-{width}.{format}`.
 *
 * The width and format are in the path rather than in a query string so the response is
 * cacheable by URL alone, which is what `immutable` needs to be safe.
 */
export function derivativeUrl(
  productId: string,
  imageId: string,
  width: number,
  format: DerivativeFormatValue,
): string {
  return `/img/${productId}/${imageId}-${width}.${format}`;
}

/** The original's URL, which is what serves while derivatives are still being written. */
export function originalUrl(productId: string, imageId: string, ext: string): string {
  return `/img/${productId}/${imageId}-original.${ext}`;
}

/* -------------------------------------------------------------------------- */
/* Markup                                                                     */
/* -------------------------------------------------------------------------- */

/** Where a `ProductImage` lives — its product id is not on the record itself. */
export interface ImageRef {
  productId: string;
  image: Pick<
    ProductImageValue,
    'id' | 'width' | 'height' | 'alt' | 'lqip' | 'derivativesReady' | 'derivativeWidths' | 'mime'
  >;
}

/**
 * The `srcset` for an image.
 *
 * `widths` defaults to the ladder for this image; passing a subset is how a thumbnail rail
 * asks for small candidates only. Whatever is passed, entries above the intrinsic width are
 * dropped and the result is never empty.
 *
 * Formats: a single `srcset` in one format, with `/img/**` upgrading the response per the
 * request's `Accept` header. The alternative — a `<picture>` with one `<source>` per format
 * — triples the markup on every card for a negotiation the edge can do once.
 */
export function buildSrcSet(
  ref: ImageRef,
  widths: readonly number[] = derivativeWidthsFor(ref.image.width),
  format: DerivativeFormatValue = 'webp',
): string {
  const intrinsic = Math.max(1, Math.floor(ref.image.width));
  const usable = [...new Set(widths.map((width) => Math.floor(width)))]
    .filter((width) => width >= 1 && width <= intrinsic)
    .sort((a, b) => a - b);
  const chosen = usable.length > 0 ? usable : [intrinsic];
  return chosen
    .map((width) => `${derivativeUrl(ref.productId, ref.image.id, width, format)} ${width}w`)
    .join(', ');
}

export type ImageContext = 'card' | 'galleryPrimary' | 'galleryThumb' | 'hero';

/**
 * The `sizes` attribute per surface, matching the grid the layout actually uses.
 *
 * `sizes` is a promise to the browser about rendered width; getting it wrong wastes the
 * whole point of `srcset`, so these mirror the breakpoints in the design's responsive
 * strategy rather than being approximations.
 */
export function pickSizes(context: ImageContext): string {
  switch (context) {
    case 'card':
      // 1 column below 640, 2 up to 1024, 3 up to 1440, 4 above.
      return '(min-width: 1440px) 22vw, (min-width: 1024px) 30vw, (min-width: 640px) 46vw, 92vw';
    case 'galleryPrimary':
      return '(min-width: 1024px) 58vw, 100vw';
    case 'galleryThumb':
      return '96px';
    case 'hero':
      return '100vw';
  }
}

/**
 * The `src` an `<img>` falls back to: the mid-ladder derivative once they exist, and the
 * stored original while they do not (Requirement 15.13 — the original keeps serving).
 */
export function fallbackSrc(ref: ImageRef): string {
  const widths = derivativeWidthsFor(ref.image.width);
  const preferred = widths.includes(960) ? 960 : (widths[widths.length - 1] ?? ref.image.width);
  if (ref.image.derivativesReady !== true) {
    return originalUrl(ref.productId, ref.image.id, extFromMime(ref.image.mime));
  }
  return derivativeUrl(ref.productId, ref.image.id, preferred, 'webp');
}

/** Content type → stored original extension. Mirrors `sniff.ts`. */
export function extFromMime(mime: string | undefined): string {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/avif':
      return 'avif';
    default:
      return 'jpg';
  }
}
