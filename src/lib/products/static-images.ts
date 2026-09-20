/**
 * Static product-image overrides.
 *
 * The site serves product photographs through `/img/**`, which reads the media object bucket. Until
 * a product's images are uploaded to the *deployed* bucket, those URLs 404 in the browser and every
 * image paints only its blurred LQIP placeholder. A committed file under
 * `public/products/{slug}/{imageId}.{ext}` is a same-origin static asset that always resolves, so
 * when one is present it is the honest source to serve.
 *
 * This reads the folder once at build time (Astro frontmatter runs in Node) and returns an
 * `imageId → URL` map. A product with no folder yields an empty map and the caller falls back to
 * the `/img/**` pipeline unchanged.
 *
 * The file must be named by the product image id it stands in for — e.g. `img_s8j0brak5e.jpeg` —
 * so the mapping to the record's `ProductImage.id` is exact and unambiguous.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** `imageId → same-origin static URL`, read from `public/products/{slug}/`. */
export function staticProductImages(slug: string): Record<string, string> {
  const dir = join(process.cwd(), 'public', 'products', slug);
  const out: Record<string, string> = {};
  try {
    for (const file of readdirSync(dir)) {
      const dot = file.lastIndexOf('.');
      const id = dot === -1 ? file : file.slice(0, dot);
      out[id] = `/products/${slug}/${file}`;
    }
  } catch {
    // No folder for this product: no overrides, fall back to the /img pipeline.
  }
  return out;
}
