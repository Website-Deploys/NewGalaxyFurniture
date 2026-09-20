// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import netlify from '@astrojs/netlify';
import tailwindcss from '@tailwindcss/vite';

/**
 * Rendering strategy (design → Architecture → Request / Render Path):
 * `output: 'static'` is the default for every route, so marketing, catalogue and
 * product pages are prerendered at build time and ship ~zero JS. Routes that must
 * reflect per-request state (`/admin/**`, `/api/**`, `/img/**`) opt out individually with
 * `export const prerender = false;` and run as **Netlify Functions** through this adapter.
 *
 * `site` is never hard-coded: it is driven by PUBLIC_SITE_URL so attaching a
 * purchased domain (or a Netlify preview deployment) is a configuration change only.
 *
 * **Netlify, not Cloudflare.** The adapter turns every on-demand route into a Netlify Function;
 * persistent storage is Netlify Blobs (images, sessions, drafts, rate-limit counters) and Neon
 * Postgres (leads, analytics, admin users), resolved through `src/lib/env.ts`. There is no Worker,
 * no `wrangler.toml`, and no `cloudflare:workers` import anywhere in the runtime.
 */
export default defineConfig({
  site: process.env.PUBLIC_SITE_URL ?? 'http://localhost:4321',
  output: 'static',
  adapter: netlify({
    /**
     * `includeFiles` bundles the product/content JSON and the image WebAssembly codecs into the
     * on-demand functions. The catalogue reads `data/**` at request time on the admin/API routes,
     * and `/img/**` derivative generation decodes/encodes through the Photon and jSquash WASM
     * modules; neither is auto-traced as a dependency, so both are named explicitly.
     */
    includeFiles: [
      './data/**/*.json',
      './node_modules/@jsquash/avif/codec/enc/avif_enc.wasm',
      './node_modules/@jsquash/avif/codec/dec/avif_dec.wasm',
      './node_modules/@cf-wasm/photon/dist/node/**/*.wasm',
    ],
  }),
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
   * (`src/lib/auth/session.ts`), stored in a Netlify Blobs store (`ngf-sessions`) via the KV
   * adapter. Astro Sessions are disabled so the adapter does not provision a second, unused session
   * store or pull the session runtime into every function bundle.
   */
  session: false,
  vite: {
    plugins: [tailwindcss()],
    /**
     * React on the type level, Preact at runtime — the design's public JS budgets (45 kB homepage,
     * 20 kB content page) are unsatisfiable with `react-dom`'s 50 kB client runtime, and
     * `preact/compat` is the same component API in ~a fifth of the bytes. Types come from React and
     * the runtime is Preact; the island surface was audited to the hooks `preact/compat` supports.
     * The regexes are anchored so `preact/compat` is not rewritten into itself.
     */
    resolve: {
      alias: [
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
