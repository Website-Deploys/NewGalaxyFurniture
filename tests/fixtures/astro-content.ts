/**
 * A stub for `astro:content`, aliased in `vitest.config.ts`.
 *
 * `astro:content` is a virtual module the Astro build creates; outside a build it does not exist, so
 * importing anything that reaches it fails at resolution. Several modules worth unit-testing sit
 * behind it — `@/lib/content/reviews` holds the `aggregateRating` rule, `@/lib/content/catalogue`
 * holds the published/unpublished filter — and their logic has nothing to do with how the entries
 * were loaded.
 *
 * The stub returns an empty collection rather than a fixture set. That is deliberate: a test that
 * cares about specific content should build it explicitly and pass it to the pure function
 * (`filterPublishedReviews`, `filterCatalogue`, `aggregateRatingFor`), not receive it from a stub
 * that every other test also sees. An empty collection makes an accidental dependency on ambient
 * data show up immediately as an empty result.
 */

export async function getCollection(): Promise<never[]> {
  return [];
}

export async function getEntry(): Promise<undefined> {
  return undefined;
}
