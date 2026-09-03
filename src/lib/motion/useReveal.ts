/**
 * `useReveal` — the design's React-side reveal hook.
 *
 * Its signature is the design's verbatim: a `RefCallback` and a `'idle' | 'revealed'` state. What
 * it deliberately does *not* do is create an observer. It joins the page's single shared reveal
 * controller — the one `runtime.ts` installs — so a page with twelve React islands still has one
 * IntersectionObserver, which is the property the design's tier two is entirely about.
 *
 * Under reduced motion the hook returns `'revealed'` on the first render and never observes
 * anything: the element is in its final state before paint, not animated into it quickly
 * (Requirement 21.11).
 *
 * **Why a `RefCallback` and not a `RefObject`.** The element has to be observed the moment React
 * attaches it. A `useEffect` reading a ref runs after paint, which on a fast connection means the
 * element can already be in view before the observer sees it — and an IntersectionObserver
 * registered on an already-intersecting element does fire, but a frame later, which is a visible
 * flash of the from-state. The callback ref observes on attach.
 *
 * Design: Motion System → Trigger mechanism.
 * Requirements: 21.10, 21.11.
 */

import { useCallback, useRef, useState } from 'react';
import type { RefCallback } from 'react';

import { REVEALED_ATTRIBUTE } from './reveal';
import { motionOK } from './preference';
import { sharedRevealController } from './runtime';

export interface UseRevealOptions {
  /** Reserved for parity with the design's signature; the shared controller owns the threshold. */
  threshold?: number;
  once?: boolean;
  rootMargin?: string;
}

export interface UseRevealResult {
  ref: RefCallback<Element>;
  state: 'idle' | 'revealed';
}

export function useReveal(_options: UseRevealOptions = {}): UseRevealResult {
  // Read once, at mount. A visitor who changes the preference mid-visit gets the new behaviour on
  // the next navigation; re-running every reveal on a media-query change would animate a page
  // someone had just asked to stop animating.
  const allowed = useRef<boolean>(motionOK());
  const [state, setState] = useState<'idle' | 'revealed'>(allowed.current ? 'idle' : 'revealed');

  const ref = useCallback<RefCallback<Element>>((element) => {
    if (element === null) return;
    if (!allowed.current) {
      element.setAttribute(REVEALED_ATTRIBUTE, '');
      return;
    }
    const controller = sharedRevealController();
    if (controller === null) {
      // The runtime has not booted — a prerendered page whose motion script has not run yet, or
      // an island mounted in a test. Revealing is the safe answer: never leave content hidden
      // because a script did not arrive.
      element.setAttribute(REVEALED_ATTRIBUTE, '');
      setState('revealed');
      return;
    }
    controller.observe(element);
    // The attribute is the source of truth; this mirrors it into React state for callers that
    // want to render differently once revealed.
    const watch = new MutationObserver(() => {
      if (element.hasAttribute(REVEALED_ATTRIBUTE)) {
        setState('revealed');
        watch.disconnect();
      }
    });
    watch.observe(element, { attributes: true, attributeFilter: [REVEALED_ATTRIBUTE] });
  }, []);

  return { ref, state };
}
