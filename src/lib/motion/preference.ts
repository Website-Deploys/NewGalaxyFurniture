/**
 * The one place that answers "may this page animate?".
 *
 * Every motion path in the codebase — the reveal observer, the hero parallax, the before/after
 * slider, and each SVG primitive's JS side — asks this module and nothing else. That is what
 * makes Requirement 21.11 checkable: there is a single predicate to audit, and it is OR-ed the
 * only way that is safe.
 *
 * **Why OR and not AND.** There are two signals: the operating system's
 * `prefers-reduced-motion` and the visitor's own footer toggle, persisted as
 * `data-motion="off"` on `<html>`. Motion is allowed only when *neither* asks for it to stop.
 * The toggle can therefore suppress motion but can never re-enable it against the OS setting —
 * which is deliberate: a visitor whose system asks for reduced motion has already answered, and
 * a site control that could override that answer would be a control that makes the site worse
 * for the people the setting exists for. The footer button reflects this by only ever *adding*
 * the attribute.
 *
 * **The environment is injected.** `MotionEnvironment` is two fields, so every decision here is
 * a pure function of two booleans and is unit-testable in Node with no DOM. The browser
 * implementation is the last twenty lines of the file and does nothing but read the two signals.
 *
 * Design: Motion System → Reduced motion.
 * Requirements: 21.10, 21.11, 21.12, 21.13.
 */

/** The media query the design names. Asked in the positive, as the design's JS mirror does. */
export const NO_PREFERENCE_QUERY = '(prefers-reduced-motion: no-preference)';

/** The attribute the footer toggle and the pre-paint script write on `<html>`. */
export const MOTION_ATTRIBUTE = 'motion';

/** The `localStorage` key the toggle persists to. */
export const MOTION_STORAGE_KEY = 'ngf:motion';

export interface MotionEnvironment {
  /** True when the platform reports *no* preference for reduced motion. */
  noPreference: boolean;
  /** The visitor's own override: `'off'` suppresses motion, anything else defers. */
  override: string | null;
}

/**
 * May this page animate?
 *
 * Returns false when the platform asks for reduced motion **or** the visitor has turned motion
 * off. Note the treatment of an *unknown* platform answer: `noPreference: false` — which is what
 * a browser without `matchMedia` produces — means "do not animate". Erring towards stillness is
 * the right default, because the cost of getting it wrong in that direction is a plainer page,
 * and in the other direction it is motion shown to someone who asked not to see it.
 */
export function motionAllowed(env: MotionEnvironment): boolean {
  if (env.override === 'off') return false;
  return env.noPreference;
}

/* -------------------------------------------------------------------------- */
/* Browser implementation                                                     */
/* -------------------------------------------------------------------------- */

/** Read the two signals from the live document. */
export function browserEnvironment(): MotionEnvironment {
  const noPreference =
    typeof window.matchMedia === 'function'
      ? window.matchMedia(NO_PREFERENCE_QUERY).matches
      : false;
  return {
    noPreference,
    override: document.documentElement.dataset[MOTION_ATTRIBUTE] ?? null,
  };
}

/** `motionAllowed` against the live document. */
export function motionOK(): boolean {
  return motionAllowed(browserEnvironment());
}

/**
 * Subscribe to changes in either signal.
 *
 * Both are watched because both can change mid-visit: the OS setting through the media query's
 * `change` event, and the toggle through a `MutationObserver` on the attribute. A page that only
 * watched the media query would keep animating after a visitor pressed the footer control, which
 * is the one case where they are actively asking and watching.
 *
 * Returns a teardown. Calls `listener` only on a change, never on subscription — a caller that
 * wants the current value reads `motionOK()`.
 */
export function onMotionChange(listener: (allowed: boolean) => void): () => void {
  let last = motionOK();
  const notify = (): void => {
    const next = motionOK();
    if (next !== last) {
      last = next;
      listener(next);
    }
  };

  const media =
    typeof window.matchMedia === 'function' ? window.matchMedia(NO_PREFERENCE_QUERY) : null;
  media?.addEventListener('change', notify);

  const attributes = new MutationObserver(notify);
  attributes.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [`data-${MOTION_ATTRIBUTE}`],
  });

  return () => {
    media?.removeEventListener('change', notify);
    attributes.disconnect();
  };
}
