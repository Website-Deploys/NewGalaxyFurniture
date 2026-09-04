/**
 * The four inline scripts the framework itself emits, by hash.
 *
 * **Why this file exists at all.** The design specifies `script-src 'self'` with no nonce and no
 * hash, and task 21.3 asks for no inline script execution anywhere so that directive can hold in
 * its strictest form. Every script this project writes now satisfies that — the pre-paint motion
 * bootstrap was moved out of an inline block into `public/ngf-motion-preference.js`, and
 * `assetsInlineLimit: 0` in `astro.config.mjs` stops Astro inlining bundled component scripts into
 * the document.
 *
 * What cannot be moved is Astro's island bootstrap. `getPrescripts` in
 * `astro/dist/runtime/server/scripts.js` writes `<script>…</script>` with the `astro-island`
 * custom-element runtime and the client-directive loader **as literal inline elements**, with no
 * configuration to externalise them. Any page with a `client:*` island therefore carries two inline
 * scripts, and islands are the architecture: removing them means removing the gallery, the search
 * box, the filter controls, the enquiry forms, and the whole admin.
 *
 * So there are exactly three options, and only one of them is honest:
 *
 * 1. Add `'unsafe-inline'` to `script-src` — which turns the directive off. Every stored-XSS defence
 *    in this project assumes it is on.
 * 2. Use a nonce — impossible for a prerendered page, whose HTML is one artifact served to
 *    everyone, so the nonce would be a constant and therefore not a nonce.
 * 3. Enumerate the hashes of those specific scripts. A hash grants execution to *that exact byte
 *    sequence* and nothing else: an injected `<script>alert(1)</script>` still does not run.
 *
 * This is option 3, and it is a strictly smaller grant than `'unsafe-inline'` by the whole space of
 * strings that are not these four.
 *
 * **How this list is kept honest.** `scripts/audit-csp.ts` runs in `postbuild` and checks both
 * directions: every inline script in the built output must hash to a member of this list, and the
 * `client:load` entry (used only by the server-rendered admin, which never appears in
 * `dist/client/`) is re-derived from the installed Astro package and must still match. An Astro
 * upgrade that changes a byte of any of these fails the build, prints the new hash, and requires a
 * human to look at what changed. A newly introduced inline script of our own fails the same gate —
 * which is the point: this list is a closed set of four framework scripts, not a place to add to.
 *
 * Design: Deployment. Requirements: 25.9, 25.10.
 */

export interface InlineScriptHash {
  /** What emits it, so a failing audit is traceable to a cause. */
  readonly source: string;
  /** `sha256-<base64>`, over the exact text between the script tags. */
  readonly hash: string;
}

export const FRAMEWORK_INLINE_SCRIPTS: readonly InlineScriptHash[] = [
  {
    source: 'astro-island custom element runtime (astro/runtime/server/astro-island.prebuilt)',
    hash: 'sha256-Ya0pUYrC7nM5Cn/056TyVuEiz6dFGrzmkWzgON0pF0U=',
  },
  {
    source: 'client:idle directive loader (astro/runtime/client/idle.prebuilt)',
    hash: 'sha256-BF0290pkb3jxQsE7z00xR8Imp8X34FLC88L0lkMnrGw=',
  },
  {
    source: 'client:visible directive loader (astro/runtime/client/visible.prebuilt)',
    hash: 'sha256-Q2BPg90ZMplYY+FSdApNErhpWafg2hcRRbndmvxuL/Q=',
  },
  {
    source: 'client:load directive loader (astro/runtime/client/load.prebuilt) — admin only',
    hash: 'sha256-QzWFZi+FLIx23tnm9SBU4aEgx4x8DsuASP07mfqol/c=',
  },
];

/** The hashes as CSP source expressions, in list order. */
export const INLINE_SCRIPT_HASH_SOURCES: readonly string[] = FRAMEWORK_INLINE_SCRIPTS.map(
  (entry) => `'${entry.hash}'`,
);
