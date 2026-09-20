/**
 * Server-side assembly of the gallery board's tiles.
 *
 * `/gallery` groups the catalogue's photographs by product and hands each board a list of tiles
 * with every URL already resolved — the same discipline `galleryImagesOf` follows for the PDP
 * island, so the derivative ladder and `sizes` table never enter the client bundle.
 *
 * Two things this file decides that the PDP gallery does not need:
 *
 * - **A category per tile** (`room` / `angle` / `detail`), derived from the image's alt text, so the
 *   board's filter tabs have something to filter on. There is no gallery-category field on the
 *   product schema, and inventing one would be a second place for an operator to get wrong; the alt
 *   text an operator already writes ("… — left angle", "… detail") is the honest signal. Anything
 *   unrecognised is a `room` view, which is the safe default for a full-scene photograph.
 * - **A short title and subtitle** for the caption overlay, again read from the alt text, falling
 *   back to the product name and a neutral line so a caption is never empty.
 */

import type { GalleryCategory, GalleryTile } from '@/components/gallery/GalleryBoard';
import { galleryImagesOf } from '@/lib/products/gallery-images';
import type { Product } from '@/schemas/product';

/** Words that place an image in a category. First match wins, in this order. */
const DETAIL_WORDS = [
  'detail',
  'close-up',
  'close up',
  'closeup',
  'stitch',
  'texture',
  'grain',
  'seam',
];
const ANGLE_WORDS = [
  'angle',
  'side',
  'top view',
  'top',
  'rear',
  'back',
  'left',
  'right',
  'profile',
  'perspective',
];

/** The alt suffix after the product name, if the operator wrote "Name — suffix". */
function suffixOf(alt: string, productName: string): string {
  const trimmed = alt.trim();
  const dash = trimmed.indexOf('—');
  if (dash !== -1) return trimmed.slice(dash + 1).trim();
  if (trimmed.toLowerCase().startsWith(productName.toLowerCase())) {
    return trimmed
      .slice(productName.length)
      .replace(/^[\s—:-]+/, '')
      .trim();
  }
  return '';
}

function categorize(alt: string): GalleryCategory {
  const lower = alt.toLowerCase();
  if (DETAIL_WORDS.some((word) => lower.includes(word))) return 'detail';
  if (ANGLE_WORDS.some((word) => lower.includes(word))) return 'angle';
  return 'room';
}

/** Title-case a short suffix like "left angle" → "Left Angle". */
function titleCase(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function labelFor(
  category: GalleryCategory,
  suffix: string,
  index: number,
): { title: string; subtitle: string } {
  if (suffix !== '') {
    const title = titleCase(suffix);
    const subtitle =
      category === 'room'
        ? 'Styled for real homes'
        : category === 'angle'
          ? 'A different perspective'
          : 'A closer look at the finish';
    return { title, subtitle };
  }
  // No suffix: the primary/full-scene shot.
  if (index === 0) return { title: 'Front View', subtitle: 'Complete set in a modern living room' };
  return { title: `View ${index + 1}`, subtitle: 'Styled for real homes' };
}

/** Every gallery tile for one product, in the island's shape. */
export function galleryTilesOf(product: Product): GalleryTile[] {
  return galleryImagesOf(product).map((image, index) => {
    const suffix = suffixOf(image.alt, product.name);
    const category = index === 0 && suffix === '' ? 'room' : categorize(image.alt);
    const { title, subtitle } = labelFor(category, suffix, index);
    return {
      id: `${product.slug}-${image.id}`,
      productSlug: product.slug,
      productName: product.name,
      href: `/product/${product.slug}`,
      category,
      title,
      subtitle,
      alt: image.alt,
      width: image.width,
      height: image.height,
      src: image.src,
      srcSet: image.srcSet,
      sizes: '(min-width: 1024px) 60vw, 100vw',
      ...(image.lqip === undefined ? {} : { lqip: image.lqip }),
      zoomSrc: image.zoomSrc,
      zoomSrcSet: image.zoomSrcSet,
    };
  });
}
