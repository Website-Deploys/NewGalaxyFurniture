/**
 * Server-side assembly of the gallery island's props.
 *
 * The island receives resolved URL strings rather than `ProductImageValue` records plus the
 * srcset builders, so `@/lib/images/srcset`, the derivative ladder, and the `sizes` table stay
 * out of the client bundle entirely. That is a payload decision (design → delivery budget) and
 * also a correctness one: there is exactly one place that decides what URL an image has, and it
 * runs at build time where a mistake fails the build rather than a visitor's page.
 *
 * Ordering: the designated primary first, then the remaining images by their `order`. The island
 * treats index 0 as the one eager, high-priority image, so "first" has to mean "the primary" and
 * not "the lowest order" — those differ whenever an operator promotes a later photograph.
 *
 * Requirements: 4.2, 4.4, 4.6, 15.10, 15.11, 15.12, 15.17.
 */

import type { GalleryImageProps } from '@/components/product/Gallery';
import {
  buildSrcSet,
  derivativeUrl,
  derivativeWidthsFor,
  fallbackSrc,
  pickSizes,
} from '@/lib/images/srcset';
import { primaryImageOf, type Product, type ProductImageValue } from '@/schemas/product';

/** The thumbnail rail slot is 96 px wide; 320 px covers it on a 3× screen. */
const THUMB_WIDTH = 320;

/** The primary first, then everything else in operator order. */
export function orderedGalleryImages(product: Product): ProductImageValue[] {
  const primary = primaryImageOf(product);
  const rest = [...product.images]
    .filter((image) => image.id !== primary?.id)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return primary === null ? rest : [primary, ...rest];
}

export function galleryImagesOf(product: Product): GalleryImageProps[] {
  return orderedGalleryImages(product).map((image) => {
    const ref = { productId: product.id, image };
    const widths = derivativeWidthsFor(image.width);
    // The largest derivative that actually exists for this image — Requirement 4.6's "largest
    // available Derivative", never an upscale of the original.
    const largest = widths[widths.length - 1] ?? image.width;
    const thumbWidth = Math.min(THUMB_WIDTH, largest);
    return {
      id: image.id,
      alt: image.alt,
      width: image.width,
      height: image.height,
      src: fallbackSrc(ref),
      srcSet: buildSrcSet(ref, widths),
      sizes: pickSizes('galleryPrimary'),
      thumbSrc: derivativeUrl(product.id, image.id, thumbWidth, 'webp'),
      thumbWidth,
      // The derivative preserves the original's ratio, so the height follows from the width.
      thumbHeight: Math.max(1, Math.round((thumbWidth * image.height) / Math.max(1, image.width))),
      ...(image.lqip === undefined ? {} : { lqip: image.lqip }),
      zoomSrc: derivativeUrl(product.id, image.id, largest, 'webp'),
      zoomSrcSet: buildSrcSet(ref, widths),
    };
  });
}
