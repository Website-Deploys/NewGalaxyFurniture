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

/** Trailing slash removed, so every join produces exactly one separator. */
function normalise(value: string): string {
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
    'CONFIG_UNAVAILABLE PUBLIC_SITE_URL — set it in wrangler.toml [vars] and in .dev.vars; ' +
      'canonical URLs are never hard-coded.',
  );
}
