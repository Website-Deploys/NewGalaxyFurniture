// @ts-check
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import netlify from '@astrojs/netlify';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';
import { unstable_readConfig } from 'wrangler';

import { cloudflareBuildEnvironment } from './scripts/cloudflare-build-environment.mjs';

/**
 * Deployment target selection.
 *
 * `DEPLOY_TARGET` chooses the adapter and the runtime resolver. It defaults to `netlify`, so with
 * the variable unset this config behaves EXACTLY as the Netlify-only config did — same adapter, same
 * `includeFiles`, and no `@/lib/env` alias — and the live Netlify deployment is unaffected.
 *
 *   (unset) | netlify  → @astrojs/netlify, storage via src/lib/env.ts (Neon + Netlify Blobs)
 *   cloudflare          → @astrojs/cloudflare, storage via src/lib/env.cloudflare.ts (D1 + KV + R2)
 *
 * Switching back to Netlify is therefore a matter of unsetting the variable; no user work is lost
 * and nothing in this file is Cloudflare-only unless the flag is set. Added for Stage 2 LOCAL
 * verification of the Cloudflare target; it does not deploy anything.
 */
const DEPLOY_TARGET = process.env.DEPLOY_TARGET === 'cloudflare' ? 'cloudflare' : 'netlify';
const isCloudflare = DEPLOY_TARGET === 'cloudflare';
const isProductionCloudflare =
  isCloudflare && !process.env.CLOUDFLARE_ENV && !process.env.NGF_PRODUCTS_DIR;
/** @type {Record<string, unknown>} */
const productionPublicConfig = {};
if (isProductionCloudflare) {
  /** @type {unknown} */
  const wranglerConfig = unstable_readConfig({ config: 'wrangler.toml' }, { hideWarnings: true });
  if (typeof wranglerConfig === 'object' && wranglerConfig !== null && 'vars' in wranglerConfig) {
    Object.assign(productionPublicConfig, wranglerConfig.vars);
  }
  if (process.env.PUBLIC_SITE_URL)
    productionPublicConfig.PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL;
}

/**
 * Rendering strategy (design → Architecture → Request / Render Path):
 * `output: 'static'` is the default for every route, so marketing, catalogue and
 * product pages are prerendered at build time and ship ~zero JS. Routes that must
 * reflect per-request state (`/admin/**`, `/api/**`, `/img/**`) opt out individually with
 * `export const prerender = false;` and run as on-demand handlers — Netlify Functions on the
 * default target, Worker routes on the Cloudflare target.
 *
 * `site` is never hard-coded: it is driven by PUBLIC_SITE_URL so attaching a
 * purchased domain (or a preview deployment) is a configuration change only.
 */

/**
 * The Netlify adapter. The adapter turns every on-demand route into a Netlify Function; persistent
 * storage is Netlify Blobs (images, sessions, drafts, rate-limit counters) and Neon Postgres (leads,
 * analytics, admin users), resolved through `src/lib/env.ts`.
 *
 * `includeFiles` bundles the product/content JSON and the image WebAssembly codecs into the
 * on-demand functions. The catalogue reads `data/**` at request time on the admin/API routes, and
 * `/img/**` derivative generation decodes/encodes through the Photon and jSquash WASM modules;
 * neither is auto-traced as a dependency, so both are named explicitly.
 */
const netlifyAdapter = netlify({
  includeFiles: [
    './data/**/*.json',
    './node_modules/@jsquash/avif/codec/enc/avif_enc.wasm',
    './node_modules/@jsquash/avif/codec/dec/avif_dec.wasm',
    './node_modules/@cf-wasm/photon/dist/node/**/*.wasm',
  ],
});

/**
 * The Cloudflare adapter. On-demand routes run as Worker handlers; storage is D1 + KV + R2 resolved
 * through `src/lib/env.cloudflare.ts`.
 *
 * - `imageService: 'compile'` runs sharp at build time rather than shipping an image service into
 *   the Worker (the pipeline's own Photon/jSquash WASM handles runtime derivatives via `/img/**`).
 * - `sessionKVBindingName: 'SESSIONS'` names the project's own KV namespace so the v14 adapter does
 *   not auto-provision an undeclared `SESSION` binding for Astro's session store. Admin auth does
 *   not use Astro Sessions (see `session: false` below); this only keeps the binding set closed.
 */
const cloudflareAdapter = cloudflare({
  imageService: 'compile',
  sessionKVBindingName: 'SESSIONS',
});

/**
 * Runtime resolver alias. On the Cloudflare target, `@/lib/env` resolves to `src/lib/env.cloudflare.ts`
 * instead of `src/lib/env.ts`. This is the single seam that switches the whole app — every consumer
 * (routes, stores, the GitHub factory, the Worker's scheduled handler) imports `@/lib/env`, so the
 * alias makes all of them use the Cloudflare resolver consistently and removes any mixed-resolver
 * risk. On the Netlify target no alias is added, so `@/lib/env` resolves to `src/lib/env.ts` as
 * before.
 *
 * It is placed BEFORE the `@` → `src` root alias in the array so the more specific match wins.
 */
const envAlias = isCloudflare
  ? [
      {
        find: /^@\/lib\/env$/,
        replacement: fileURLToPath(new URL('./src/lib/env.cloudflare.ts', import.meta.url)),
      },
    ]
  : [];

export default defineConfig({
  site: process.env.PUBLIC_SITE_URL ?? 'http://localhost:4321',
  output: 'static',
  adapter: isCloudflare ? cloudflareAdapter : netlifyAdapter,
  integrations: [
    /**
     * `experimentalDisableStreaming` is required by the Preact swap, not a preference.
     *
     * `@astrojs/react`'s server renderer picks a strategy by feature detection:
     * `renderToReadableStream` if the `react-dom/server` default export has it, otherwise
     * `renderToPipeableStream`. Under the `preact/compat/server` mapping the detection can fall
     * through to a strategy the build does not export; setting this makes the renderer call
     * `renderToString`, which the Preact compat build does export.
     *
     * Nothing is lost: an island is rendered to a string and embedded in the page either way.
     */
    react({ experimentalDisableStreaming: true }),
  ],
  /**
   * Astro's own session store is NOT used by admin authentication — the design specifies opaque
   * sessions with an explicit 2 h idle / 12 h absolute policy and a per-session CSRF token
   * (`src/lib/auth/session.ts`), stored in a KV namespace (`SESSIONS` / Netlify Blobs `ngf-sessions`)
   * via the KV adapter. Astro Sessions are disabled so the adapter does not provision a second,
   * unused session store or pull the session runtime into every function/worker bundle.
   */
  session: false,
  vite: {
    plugins: [
      tailwindcss(),
      ...(isProductionCloudflare ? [cloudflareBuildEnvironment(productionPublicConfig)] : []),
    ],
    /**
     * React on the type level, Preact at runtime — the design's public JS budgets (45 kB homepage,
     * 20 kB content page) are unsatisfiable with `react-dom`'s 50 kB client runtime, and
     * `preact/compat` is the same component API in ~a fifth of the bytes. Types come from React and
     * the runtime is Preact; the island surface was audited to the hooks `preact/compat` supports.
     * The regexes are anchored so `preact/compat` is not rewritten into itself.
     *
     * The `envAlias` (Cloudflare target only) is spread in first so it matches before any broader
     * alias; the react→preact rewrites are unchanged on both targets.
     */
    resolve: {
      alias: [
        ...envAlias,
        { find: /^react$/, replacement: 'preact/compat' },
        { find: /^react-dom$/, replacement: 'preact/compat' },
        { find: /^react-dom\/client$/, replacement: 'preact/compat/client' },
        { find: /^react-dom\/server$/, replacement: 'preact/compat/server' },
        { find: /^react\/jsx-runtime$/, replacement: 'preact/compat/jsx-runtime' },
        { find: /^react\/jsx-dev-runtime$/, replacement: 'preact/compat/jsx-dev-runtime' },
      ],
    },
    build: {
      /**
       * No inlined assets, and — the reason this is set — no inlined *scripts*. The deployment
       * serves `script-src 'self'` with no nonce and no hash, so an inlined chunk is blocked. Zero
       * externalises every script into `_astro/*.js`, which the policy allows and the immutable
       * cache headers cover. `scripts/audit-csp.ts` enforces this.
       */
      assetsInlineLimit: 0,
      rollupOptions: {
        output: {
          /**
           * Everything under `src/lib/motion/` goes into one named chunk so `size-limit` has a
           * stable glob (`dist/client/_astro/ngf-motion*.js`) to hold to the 14 KB motion budget.
           */
          manualChunks(id) {
            return id.includes('/src/lib/motion/') ? 'ngf-motion' : undefined;
          },
        },
      },
    },
  },
  build: {
    // Content-hashed asset filenames so /_astro/** can be cached immutably.
    assets: '_astro',
  },
});
