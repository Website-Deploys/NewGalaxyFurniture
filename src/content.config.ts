/**
 * Astro Content Layer collections.
 *
 * The same Zod schemas that gate the admin write endpoint and CI gate the build
 * here, so a product file cannot reach a rendered page without satisfying every
 * cross-field invariant. `data/` is the source of truth; there is no second
 * definition of a product anywhere in the codebase.
 *
 * Entry ids come from the glob loader's default `generateId`, which prefers
 * `data.slug` — so a product's entry id is its slug, matching its filename and its
 * public URL (design → Data Models → File layout rules).
 *
 * `data/products/` is intentionally empty: no real product data or photography
 * exists yet, so every catalogue surface renders its designed empty state. Demo
 * products live in `tests/fixtures/` and are never written here.
 *
 * Design: Data Models → File layout rules; Architecture → Folder Structure.
 * Requirements: 17.1, 17.7, 18.5, 26.11.
 */

import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';

import { CategorySchema } from './schemas/category';
import { ProductSchema } from './schemas/product';
import { ReviewSchema } from './schemas/review';

/**
 * Where product files are read from.
 *
 * `./data/products` in every real build — the repository is the source of truth and nothing
 * overrides that. The override exists for one reason: the end-to-end suite has to exercise the
 * product surfaces (a detail page, a card, a filter with real values, a `Product` block in the
 * structured data) and the spec forbids writing a demo product into `data/products/`. So
 * `npm run e2e:prepare` materialises `tests/fixtures/products.ts` into a git-ignored directory and
 * points this at it for that build only.
 *
 * It is a directory path, not data: nothing here can invent a product, and a build with the
 * variable unset — which is every build CI or Cloudflare runs — reads exactly what it did before.
 */
const PRODUCTS_DIR = process.env.NGF_PRODUCTS_DIR ?? './data/products';

const products = defineCollection({
  loader: glob({ pattern: '**/*.json', base: PRODUCTS_DIR }),
  schema: ProductSchema,
});

const categories = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './data/categories' }),
  schema: CategorySchema,
});

const reviews = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './data/reviews' }),
  schema: ReviewSchema,
});

export const collections = { products, categories, reviews };
