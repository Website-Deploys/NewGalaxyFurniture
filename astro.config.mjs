// @ts-check
import { defineConfig, sessionDrivers } from 'astro/config';
import react from '@astrojs/react';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

/**
 * Rendering strategy (design → Architecture → Request / Render Path):
 * `output: 'static'` is the default for every route, so marketing, catalogue and
 * product pages are prerendered at build time and ship ~zero JS. Routes that must
 * reflect per-request state (`/admin/**`, `/api/**`) opt out individually with
 * `export const prerender = false;` and run as Worker handlers.
 *
 * `site` is never hard-coded: it is driven by PUBLIC_SITE_URL so attaching a
 * purchased domain (or a preview deployment) is a configuration change only.
 */
export default defineConfig({
  site: process.env.PUBLIC_SITE_URL ?? 'http://localhost:4321',
  output: 'static',
  adapter: cloudflare({
    // Local KV/D1/R2 bindings from wrangler.toml are exposed during `astro dev`
    // by the adapter's built-in Cloudflare Vite plugin. The old
    // `platformProxy: { enabled: true }` option was removed in @astrojs/cloudflare v14
    // because that behaviour is now the default and is no longer opt-in.

    // Run image optimization with sharp at build time rather than shipping an
    // image service into the Worker.
    imageService: 'compile',

    // The v14 adapter auto-provisions a KV namespace for Astro's session store
    // unless a namespace with this exact name is already declared in the wrangler
    // config. Its default name is `SESSION`, which this project does not declare,
    // so leaving it unset made the adapter inject an undeclared, auto-provisioned
    // `SESSION` binding — the precise outcome the session block below exists to
    // prevent. Naming our own `SESSIONS` namespace keeps the binding set closed.
    sessionKVBindingName: 'SESSIONS',
  }),
  integrations: [
    /**
     * `experimentalDisableStreaming` is required by the Preact swap, not a preference.
     *
     * `@astrojs/react`'s server renderer picks a strategy by feature detection:
     * `renderToReadableStream` if the `react-dom/server` default export has it, otherwise
     * `renderToPipeableStream`. Under the `browser`/`worker` export condition — which is what the
     * Cloudflare build resolves — `preact/compat/server` maps to `server.browser.js`, whose default
     * export carries only `renderToString`. The detection therefore falls through to
     * `renderToPipeableStream`, which is `undefined` there, and every prerender fails with
     * `renderToPipeableStream is not a function`. Setting this makes the renderer call
     * `renderToString`, which that build does export.
     *
     * Nothing is lost: an island is rendered to a string and embedded in the page either way, so
     * there is no stream for a visitor to benefit from.
     */
    react({ experimentalDisableStreaming: true }),
  ],
  /**
   * Astro's own session store. Admin authentication does NOT use it — the design
   * specifies opaque KV sessions with an explicit 2 h idle / 12 h absolute policy
   * and a per-session CSRF token (`src/lib/auth/session.ts`). This is declared
   * only so the adapter does not default to an undeclared `SESSION` binding, and
   * it is namespaced under its own key prefix so it can never collide with the
   * `session:{id}` records the admin layer owns.
   */
  session: {
    // Astro 6 deprecated the `driver: '<name>'` + `options: {}` string signature
    // in favour of the typed `sessionDrivers.*` factories, which take the driver
    // options directly. Same driver, same binding, same key prefix.
    driver: sessionDrivers.cloudflareKVBinding({ binding: 'SESSIONS', base: 'astro-session' }),
  },
  vite: {
    plugins: [tailwindcss()],
    /**
     * React on the type level, Preact at runtime.
     *
     * **Why.** The design's public asset budgets are 45 kB of JS on the homepage and 20 kB on a
     * static content page. `react-dom`'s client runtime is 50.2 kB Brotli on its own, so those
     * budgets are unsatisfiable by construction while React hydrates a public page — no arrangement
     * of `client:*` directives changes a number that large. `preact/compat` is the same component
     * API in roughly a fifth of the bytes, which brings every route inside its budget without
     * rewriting a single island. (The 220 kB admin allowance exists precisely because a framework
     * lives there; the public numbers imply the public half ships none.)
     *
     * **A deliberate deviation from the design's technology decisions**, which name React 19
     * islands, taken with the operator's agreement rather than silently. What is unchanged: the
     * components are still `.tsx` written against the React API, `@astrojs/react` is still the
     * renderer integration, `@types/react` still types them, and `tsc` still checks them against
     * React's own declarations.
     *
     * **What that costs, stated plainly.** Types come from React and the runtime is Preact, so an
     * API that React has and `preact/compat` does not would typecheck and fail in the browser. The
     * exposure is bounded and was audited before the swap: every island uses `useState`,
     * `useCallback`, `useRef`, `useEffect`, `useMemo` and `useId`, nothing imports `react-dom`
     * directly, and no concurrent, Suspense, or Server Component API appears anywhere in `src/`.
     * Adding one would need checking against `preact/compat` first.
     *
     * The regexes are anchored so `preact/compat` — which imports `preact` — is not rewritten into
     * itself.
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
       * No inlined assets, and — the reason this is set — no inlined *scripts*.
       *
       * Astro inlines a client script chunk into the HTML whenever the chunk is smaller than this
       * limit (`shouldInlineAsset` in `core/build/plugins/plugin-scripts`, Vite's default 4096).
       * That is a sensible default for most sites and incompatible with this one: the deployment
       * serves `script-src 'self'` with no nonce and no hash, so an inlined chunk does not run —
       * it is blocked. With the default limit the island hydration bootstrap, the `astro-island`
       * runtime, and the two small shell scripts were all inlined, which `scripts/audit-csp.ts`
       * counted as 109 violations across 24 pages.
       *
       * Zero externalises every one of them into `_astro/*.js`, which the policy allows, which the
       * immutable cache headers cover, and which `size-limit` can actually measure. The cost is a
       * handful of extra same-origin requests on a warm HTTP/2 connection; the alternative is a CSP
       * exemption on every page, permanently.
       */
      assetsInlineLimit: 0,
      rollupOptions: {
        output: {
          /**
           * Everything under `src/lib/motion/` goes into one named chunk.
           *
           * Requirement 21.15 caps motion-related client script at 14 KB Brotli, and a budget is
           * only enforceable against a file whose path is predictable. Astro's default output is
           * `_astro/<name>.<hash>.js` with the name derived from the entry, so the motion runtime
           * would otherwise land in a differently-named chunk from build to build — or be inlined
           * into a shared one, where its size is unmeasurable. Naming it here gives `size-limit` a
           * stable glob (`dist/client/_astro/ngf-motion*.js`) to hold to 14 KB.
           *
           * It also guarantees the budget is honest in the other direction: no motion module can be
           * quietly duplicated into a page chunk and escape the measurement.
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
