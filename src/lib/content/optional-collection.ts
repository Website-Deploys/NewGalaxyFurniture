/**
 * Reading a content collection that is *allowed* to be empty.
 *
 * `data/products/` and `data/reviews/` ship empty and are meant to: no real photography or real
 * customer words exist yet, and inventing either is the one thing this project refuses to do
 * (design → Open Items; `src/content.config.ts`). Every catalogue and review surface therefore
 * renders a designed empty state rather than a list, and that is the intended production state on
 * the day the site goes live — not a defect waiting to be fixed.
 *
 * Astro disagrees, once per render. `getCollection()` cannot distinguish "this collection has no
 * entries" from "you spelled the collection name wrong", so when the glob loader matched no files
 * the collection is absent from the data store and `getCollection()` returns `[]` *and* prints:
 *
 *     The collection "products" does not exist or is empty. Please check your content config
 *     file for errors.
 *
 * There is nothing to check and no error to find. Left alone the line appears interleaved into the
 * build's page list five times over — on `/`, `/collection`, `/gallery`, `/reviews`, and
 * `sitemap.xml` — which trains whoever reads a build log to skip warnings, and a skipped warning
 * is worse than a loud one.
 *
 * So this module drops exactly that sentence, for exactly the two collections declared here, and
 * nothing else: not a different message, not a different collection, not a warning with extra
 * arguments. The check is a full-string equality against the message Astro builds, so a genuine
 * misconfiguration of `categories` — the collection that must never be empty — still prints.
 *
 * Nor is the information lost. `validate:content` is the `prebuild` gate and reports the real
 * counts from the real files every single build:
 *
 *     validate:content — 13 file(s) valid under data/ (0 product(s), 9 category/categories).
 *
 * That is the accurate, authoritative version of what Astro was guessing at.
 *
 * Design: Data Models → File layout rules; Open Items.
 * Requirements: 1.16, 17.7, 18.5, 26.11.
 */

/**
 * The collections whose emptiness is a documented launch state.
 *
 * `categories` is deliberately absent: nine category files are required for the site to have
 * navigation at all, so an empty `categories` collection *is* the misconfiguration Astro's
 * warning describes and must keep warning.
 */
export const MAY_BE_EMPTY_COLLECTIONS = ['products', 'reviews'] as const;

export type OptionalCollection = (typeof MAY_BE_EMPTY_COLLECTIONS)[number];

/**
 * The exact sentence Astro emits for a collection that is not in the data store.
 *
 * Reproduced from `astro/dist/content/runtime.js` — `JSON.stringify` on the collection name and
 * all. A full-string match is the point: if Astro ever rewords it, this stops matching, the
 * warning comes back, and someone reads this comment. That failure mode is a noisy build log,
 * which is the safe direction to fail in.
 */
export function emptyCollectionWarning(collection: string): string {
  return `The collection ${JSON.stringify(collection)} does not exist or is empty. Please check your content config file for errors.`;
}

type WarnFn = (...args: unknown[]) => void;

const SUPPRESSED: ReadonlySet<string> = new Set(
  MAY_BE_EMPTY_COLLECTIONS.map((collection) => emptyCollectionWarning(collection)),
);

let installed = false;

/**
 * Install the filter on `console.warn`, once.
 *
 * Installed once and left in place rather than swapped around each read, because page renders
 * interleave: saving and restoring `console.warn` per call would race two concurrent reads and
 * could drop an unrelated warning that happened to land in the window. A single permanent filter
 * with a closed set of exact-match strings has no such window.
 *
 * Exported for the unit test; production code reaches it through `readOptionalCollection`.
 */
export function installEmptyCollectionFilter(): void {
  if (installed) return;
  installed = true;

  const original: WarnFn = console.warn.bind(console) as WarnFn;
  console.warn = (...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === 'string' && SUPPRESSED.has(args[0])) return;
    original(...args);
  };
}

/**
 * Read a collection that may legitimately hold nothing.
 *
 * `read` is the caller's own `getCollection('products' | 'reviews')` call, so the entry type stays
 * exactly what Astro's generated types say it is — this wrapper adds no cast and no `any`, and the
 * collection being read is visible at the call site.
 */
export async function readOptionalCollection<T>(read: () => Promise<T[]>): Promise<T[]> {
  installEmptyCollectionFilter();
  return read();
}
