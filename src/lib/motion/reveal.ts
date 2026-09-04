/**
 * Tier two of the trigger mechanism: **one** IntersectionObserver for the whole page.
 *
 * Tier one is CSS (`animation-timeline: view()` behind `@supports`, in `motion.css`) and costs no
 * JavaScript at all. This module is what runs where that is unsupported, and the design is
 * explicit that it is a single shared observer rather than one per element — so a catalogue page
 * with sixty cards creates one observer, not sixty. Elements unobserve as they reveal, so the
 * observer's entry list shrinks to nothing as the visitor scrolls and the page ends up costing
 * nothing again.
 *
 * What a reveal *is*: a `data-revealed` attribute on the element. Not a class, not an inline
 * style, and nothing that requires JavaScript to have run for the element to be readable. The
 * stylesheet declares the from-state under `[data-reveal]:not([data-revealed])` and the
 * to-state unconditionally — so an element whose observer never fires ends up in its final
 * state rather than invisible. That inversion is the whole safety property: a broken or blocked
 * script leaves a plain page, never a blank one.
 *
 * `will-change` is set when an element is about to animate and removed when it finishes, which is
 * what the design means by "never left standing": a promoted layer costs memory for as long as it
 * exists, and a page with sixty permanently promoted cards is slower than one with none.
 *
 * Design: Motion System → Trigger mechanism.
 * Requirements: 21.8, 21.10, 21.11.
 */

/** The attribute an element opts in with. */
export const REVEAL_ATTRIBUTE = 'data-reveal';

/** The attribute set once an element has revealed. */
export const REVEALED_ATTRIBUTE = 'data-revealed';

/** The design's default: reveal once, a little before the element is fully in view. */
export const DEFAULT_REVEAL_OPTIONS = {
  threshold: 0.15,
  rootMargin: '0px 0px -10% 0px',
} as const;

/**
 * Enough of `IntersectionObserver` to be substitutable in a test.
 *
 * Declared structurally rather than imported from the DOM lib so this module can be exercised in
 * Node: the reveal *policy* — reveal once, unobserve immediately, drop `will-change` on
 * completion — is the part worth testing, and it does not need a real viewport.
 */
export interface ObserverLike {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
}

export interface ObserverEntryLike {
  target: Element;
  isIntersecting: boolean;
}

export type ObserverFactory = (
  callback: (entries: ObserverEntryLike[]) => void,
  options: { threshold: number; rootMargin: string },
) => ObserverLike;

export interface RevealController {
  /** Start watching an element. A second call for the same element is a no-op. */
  observe(element: Element): void;
  /** Watch every `[data-reveal]` descendant of `root` that has not already revealed. */
  observeAll(root: ParentNode): void;
  /** Reveal an element now, without waiting for intersection. */
  revealNow(element: Element): void;
  /**
   * Stop watching one element without revealing it.
   *
   * This is the unmount path: a React island whose element leaves the document before it ever
   * intersected must not stay in `watched`, or the controller holds a detached node alive and
   * `pending()` never returns to zero. Unlike `revealNow` it makes no visual claim — the element
   * is going away, so there is nothing to reveal.
   */
  unobserve(element: Element): void;
  /** Stop watching everything and release the observer. */
  destroy(): void;
  /** How many elements are still being watched. For tests and dev assertions. */
  pending(): number;
}

export interface RevealOptions {
  threshold?: number;
  rootMargin?: string;
  observerFactory?: ObserverFactory;
  /**
   * When false, every observed element is revealed immediately and no observer is created.
   * This is the reduced-motion path, and it is a *parameter* rather than a check inside the
   * callback so that under reduced motion no observer exists at all.
   */
  animate?: boolean;
}

/** How long `will-change` is held after a reveal starts. The longest reveal duration plus slack. */
export const WILL_CHANGE_HOLD_MS = 1200;

/**
 * Mark an element revealed.
 *
 * `will-change` is applied on the same frame the attribute is set and removed after the animation
 * can have finished. There is no `animationend` listener, and that is deliberate: an element whose
 * reveal is a CSS *transition* fires `transitionend` per property, an element whose reveal is an
 * animation fires `animationend`, and an element that is already in its final state fires neither.
 * A timer is the one mechanism that is correct in all three cases.
 */
function markRevealed(element: Element, animate: boolean, hold: number): void {
  /**
   * Duck-typed on `style` rather than `element instanceof HTMLElement`, and that is a fix rather
   * than a style choice: the nine animated primitives are `<svg>` elements, which are `SVGElement`
   * and **not** `HTMLElement`, so an `instanceof HTMLElement` guard would silently skip
   * `will-change` on every illustration in the system — the elements that most need the promotion,
   * since they animate `stroke-dashoffset` across a dozen paths. Reading `.style` covers both, and
   * it is also what makes this function testable without a DOM.
   */
  const styled = element as Element & { style?: { willChange: string } };
  if (animate && styled.style !== undefined) {
    styled.style.willChange = 'transform, opacity';
    globalThis.setTimeout(() => {
      if (styled.style !== undefined) styled.style.willChange = '';
    }, hold);
  }
  element.setAttribute(REVEALED_ATTRIBUTE, '');
}

/**
 * Create the page's reveal controller.
 *
 * One per page. `runtime.ts` creates it; nothing else should.
 */
export function createRevealController(options: RevealOptions = {}): RevealController {
  const animate = options.animate ?? true;
  const threshold = options.threshold ?? DEFAULT_REVEAL_OPTIONS.threshold;
  const rootMargin = options.rootMargin ?? DEFAULT_REVEAL_OPTIONS.rootMargin;
  const watched = new Set<Element>();

  // Under reduced motion there is no observer to create: every element is revealed on the spot,
  // in its final state, and the page never allocates one (Requirement 21.11).
  if (!animate) {
    return {
      observe(element) {
        element.setAttribute(REVEALED_ATTRIBUTE, '');
      },
      observeAll(root) {
        for (const element of root.querySelectorAll(`[${REVEAL_ATTRIBUTE}]`)) {
          element.setAttribute(REVEALED_ATTRIBUTE, '');
        }
      },
      revealNow(element) {
        element.setAttribute(REVEALED_ATTRIBUTE, '');
      },
      unobserve() {
        /* nothing was ever observed */
      },
      destroy() {
        /* nothing was allocated */
      },
      pending: () => 0,
    };
  }

  const factory: ObserverFactory =
    options.observerFactory ??
    ((callback, init) =>
      new IntersectionObserver((entries) => {
        callback(
          entries.map((entry) => ({ target: entry.target, isIntersecting: entry.isIntersecting })),
        );
      }, init));

  let observer: ObserverLike | null = null;

  const handle = (entries: ObserverEntryLike[]): void => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      // Unobserve *before* revealing: `once` is the default and a second callback for an element
      // mid-reveal would re-apply `will-change` and restart the hold timer.
      observer?.unobserve(entry.target);
      watched.delete(entry.target);
      markRevealed(entry.target, true, WILL_CHANGE_HOLD_MS);
    }
    if (watched.size === 0) {
      observer?.disconnect();
      observer = null;
    }
  };

  const ensure = (): ObserverLike => {
    observer ??= factory(handle, { threshold, rootMargin });
    return observer;
  };

  return {
    observe(element) {
      if (element.hasAttribute(REVEALED_ATTRIBUTE) || watched.has(element)) return;
      watched.add(element);
      ensure().observe(element);
    },
    observeAll(root) {
      for (const element of root.querySelectorAll(`[${REVEAL_ATTRIBUTE}]`)) {
        this.observe(element);
      }
    },
    revealNow(element) {
      if (watched.delete(element)) observer?.unobserve(element);
      markRevealed(element, true, WILL_CHANGE_HOLD_MS);
    },
    unobserve(element) {
      if (!watched.delete(element)) return;
      observer?.unobserve(element);
      if (watched.size === 0) {
        observer?.disconnect();
        observer = null;
      }
    },
    destroy() {
      observer?.disconnect();
      observer = null;
      watched.clear();
    },
    pending: () => watched.size,
  };
}
