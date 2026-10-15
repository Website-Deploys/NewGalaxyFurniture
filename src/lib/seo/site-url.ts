/**
 * Where the origin comes from, and the only place it is resolved.
 *
 * `PUBLIC_SITE_URL` is the single configuration value that carries the domain. Attaching the
 * purchased domain is therefore one environment change, and a preview deployment advertises its
 * own origin rather than the production one — which is what keeps preview content out of the
 * production canonical tags (Requirement 28.2).
 *
 * Two resolution sources, in order:
 *
 * 1. `import.meta.env.PUBLIC_SITE_URL` — the build-time value, which is what prerendered pages
 *    have. Vite inlines it, so this works inside the Worker bundle as well.
 * 2. `Astro.site` — configured in `astro.config.mjs` *from* `PUBLIC_SITE_URL`, so it is the same
 *    value by a different route. It is the fallback because `astro check` and `astro build` are
 *    routinely run without an environment file, and a build that fails on a missing canonical
 *    origin would make the type gate depend on deployment configuration.
 *
 * No literal hostname appears here or anywhere else under `src/` — a unit test asserts it.
 *
 * Requirements: 23.3, 28.2, 28.9.
 */

/**
 * The single site-URL normalizer for the whole codebase.
 *
 * Trims surrounding whitespace and removes **every** trailing slash (`/+$`, not just one), so an
 * origin with no trailing slash, one trailing slash, or several all normalise to the same
 * slash-free origin and every subsequent join produces exactly one separator. Stripping all
 * trailing slashes rather than one is deliberate: it means a canonical tag and a redirect target
 * cannot disagree because the configured origin happened to carry a double slash. (No example URL
 * is written here on purpose — a hostname literal anywhere under `src/` is itself a lint/test
 * failure; see `tests/unit/seo.meta.test.ts`.)
 *
 * Exported because the environment resolvers (`src/lib/env.ts`, `src/lib/env.cloudflare.ts`) MUST
 * normalise `PUBLIC_SITE_URL` the same way this render-path resolver does — there is one
 * normalization implementation, here, and they call it. (This module imports nothing, so importing
 * it from the env resolvers creates no cycle.)
 */
export function normalise(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * The deployment origin.
 *
 * `fallback` is `Astro.site`, which every `.astro` file has. Callers outside a render pass
 * nothing and rely on the environment.
 */
export function resolveSiteUrl(fallback?: URL | null): string {
  const fromEnv = (import.meta.env as Record<string, string | undefined>).PUBLIC_SITE_URL;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return normalise(fromEnv);
  if (fallback !== undefined && fallback !== null) return normalise(fallback.href);
  throw new Error(
    'CONFIG_UNAVAILABLE PUBLIC_SITE_URL — set it in the Netlify site environment and in .env; ' +
      'canonical URLs are never hard-coded.',
  );
}
