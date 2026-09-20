import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Two projects, because the two suites have different failure economics:
 * `unit` is fast and example-based, `property` runs hundreds of cases per
 * assertion and needs a longer timeout. `npm test` runs both.
 *
 * Design: Testing Strategy → Unit testing, Property-based testing.
 * Requirements: 27.12.
 */
const alias = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
  /**
   * `astro:content` is a virtual module that only exists inside an Astro build. The readers that
   * import it — `@/lib/content/catalogue`, `@/lib/content/reviews` — carry rules worth testing
   * (the published filter, the `aggregateRating` refusal) that have nothing to do with loading.
   * The stub returns an empty collection, so a test that depends on ambient content fails visibly
   * rather than passing on data it did not declare.
   */
  'astro:content': fileURLToPath(new URL('./tests/fixtures/astro-content.ts', import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    // Suites are added task by task; an empty project must not fail the gate.
    passWithNoTests: true,
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          root: fileURLToPath(new URL('.', import.meta.url)),
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['./tests/setup.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'property',
          root: fileURLToPath(new URL('.', import.meta.url)),
          include: ['tests/property/**/*.property.test.ts'],
          environment: 'node',
          setupFiles: ['./tests/setup.ts'],
          // 300 runs per property; a slow property must not be cut off mid-shrink.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
