/**
 * Unique DOM ids across islands.
 *
 * **The defect this exists to prevent.** `useId()` is documented to return an id unique within the
 * document, and under React it is: React derives it from a per-root `identifierPrefix`, which Astro
 * sets to a different value for every island it renders. Under `preact/compat` — which is what this
 * project ships at runtime, by the deliberate swap documented in `astro.config.mjs` —`useId()` is
 * derived from the vnode's *position in its own tree*, and every island is its own tree. So the
 * first `useId()` in the header's search box and the first `useId()` in the mobile menu are both
 * `P0-0`, and the id is unique only within one island.
 *
 * It is easy to under-rate that. Duplicate ids are not a lint nicety: they silently break the two
 * mechanisms this UI leans on hardest.
 *
 * - `<label for="P0-0-name">` resolves to the *first* element with that id in the document. On
 *   `/contact` that meant the callback form's labels pointed at the contact form's inputs — clicking
 *   "Your name" above one form focused the field in the other, and a screen reader announced the
 *   wrong control (WCAG 1.3.1, 4.1.2).
 * - `aria-controls` and `aria-describedby` resolve the same way. Both search comboboxes and the
 *   mobile menu's toggle all claimed to control an element with id `P0-0`, so two of the three
 *   pointed at someone else's listbox.
 *
 * **The fix.** A caller-supplied scope, prepended. The scope is a constant chosen per island — the
 * search box uses its `variant`, the enquiry form its lead `type` — so it is identical on the server
 * and in the browser, which `useId`-based ids must be or hydration rewrites every `for` and
 * `aria-*` attribute on the first paint.
 *
 * `tests/e2e/a11y.spec.ts` asserts no page serves a duplicate id, so a new island that forgets to
 * scope its ids fails the suite rather than quietly mislabelling a control.
 *
 * Requirements: 24.5, 24.9, 24.10.
 * Design: Pages, Navigation, and States → Accessibility.
 */

import { useId } from 'react';

/**
 * An id unique across the whole document.
 *
 * @param scope A constant that identifies this island instance — not a value derived from state,
 *   from a random source, or from anything that could differ between the server render and
 *   hydration.
 */
export function useScopedId(scope: string): string {
  // `useId` returns something like `P0-0`; both halves are already id-safe, and the separator keeps
  // `scope`'s own hyphens from making two different pairs collide.
  return `${scope}--${useId()}`;
}
