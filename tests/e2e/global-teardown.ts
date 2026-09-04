import { rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Remove every trace of the fixture catalogue when the suite finishes.
 *
 * **The trap this closes.** Astro's content layer caches the collection it loaded in
 * `node_modules/.astro/data-store.json`, and the cache is keyed by collection name — not by the
 * directory the loader read from. So after an end-to-end run had built the site with
 * `NGF_PRODUCTS_DIR` pointing at the fixtures, the *next* ordinary `npm run build` reused that store
 * and emitted `/product/demo-l-shape-sofa` and friends, with the glob loader cheerfully reporting
 * "No files found in data/products" in the same breath. A developer who built locally after running
 * the suite would have had two demo products in `dist/` and no indication of it.
 *
 * Production is not exposed to this — Cloudflare Workers Builds and CI both build from a clean
 * checkout with no `node_modules/.astro` — but "it only misleads you locally" is not a good enough
 * answer for something that ends up in a `dist/` someone might deploy by hand.
 *
 * So the fixtures and the cache both go, and the next build re-reads `data/products/`, which is
 * empty, and produces the empty catalogue it should. `scripts/prepare-e2e.ts` clears the same cache
 * on the way *in*, for the same reason in reverse.
 *
 * Design: Testing Strategy → End-to-end testing.
 */
export default function globalTeardown(): void {
  for (const path of [join('node_modules', '.astro'), '.e2e']) {
    rmSync(path, { recursive: true, force: true });
  }
}
