/**
 * Focus containment for modal surfaces — the mobile menu panel, the filter bottom sheet,
 * and (from task 15.3) the gallery lightbox.
 *
 * One implementation for all of them, because a focus trap that is *nearly* right is worse
 * than none: a keyboard visitor who tabs out of an open panel lands on controls that are
 * visually covered, cannot see where focus is, and has no way back. Requirements 9.5, 9.6,
 * 24.5, and 24.7 all describe pieces of the same behaviour, so they are implemented once.
 *
 * What this does NOT do is take focus away from the caller: `activate` returns a teardown
 * function and the caller decides what to focus on the way out (Requirement 9.6 requires the
 * opener, which only the caller knows).
 */

/**
 * Anything focusable, minus the things that are focusable but shouldn't be tab stops.
 * `[hidden]` and `disabled` elements and `tabindex="-1"` are excluded by the filter below
 * rather than by the selector, because visibility is a computed property.
 */
const FOCUSABLE =
  'a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => {
    if (element.hasAttribute('disabled') || element.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    if (element.tabIndex < 0) return false;
    // `offsetParent === null` catches `display: none` on the element or any ancestor, which
    // is how the panel's own collapsed state is expressed.
    return element.offsetParent !== null || element === document.activeElement;
  });
}

export interface TrapOptions {
  /** Called on Escape. The caller closes and restores focus itself. */
  onEscape?: () => void;
  /** Focused on activation. Defaults to the first focusable descendant. */
  initialFocus?: HTMLElement | null;
}

/**
 * Confine Tab and Shift+Tab to `root` and lock scrolling on `document.body`.
 *
 * Scroll lock is `overflow: hidden` plus a compensating `padding-right` for the scrollbar
 * width, so locking does not shift the page behind the panel — a visible jump on open reads
 * as a bug even though the panel covers it.
 *
 * Returns a teardown that restores both.
 */
export function activateTrap(root: HTMLElement, options: TrapOptions = {}): () => void {
  const body = document.body;
  const previousOverflow = body.style.overflow;
  const previousPadding = body.style.paddingRight;
  const scrollbar = window.innerWidth - document.documentElement.clientWidth;

  body.style.overflow = 'hidden';
  if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      options.onEscape?.();
      return;
    }
    if (event.key !== 'Tab') return;

    const stops = focusableWithin(root);
    if (stops.length === 0) {
      // Nothing to move to; keep focus where it is rather than letting it escape.
      event.preventDefault();
      return;
    }
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (first === undefined || last === undefined) return;

    const active = document.activeElement;
    if (event.shiftKey && (active === first || !root.contains(active))) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && (active === last || !root.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  document.addEventListener('keydown', onKeyDown, true);

  const target = options.initialFocus ?? focusableWithin(root)[0] ?? root;
  target.focus();

  return () => {
    document.removeEventListener('keydown', onKeyDown, true);
    body.style.overflow = previousOverflow;
    body.style.paddingRight = previousPadding;
  };
}
