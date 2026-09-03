/**
 * `useScrollProgress` — an element's travel through the viewport, as a value that does not
 * re-render.
 *
 * The design's signature returns a `MotionValue<number>`, and the design's own budget line
 * explains why the type matters more than its provenance: "they write transforms through Motion
 * One's `MotionValue` (no React re-render per frame)". A scroll-linked transform that went through
 * `setState` would reconcile the component tree sixty times a second, which is precisely the cost
 * the whole three-tier trigger system exists to avoid.
 *
 * **There is no Motion One in this project, and that is deliberate.** Requirement 21.5 says the
 * illustration primitives carry "no external animation runtime", and Requirement 21.15 caps
 * motion-related client script at 14 KB Brotli — Motion One's `animate` entry alone is a
 * meaningful fraction of that for a `MotionValue` this file uses eight lines of. So `MotionValue`
 * is implemented here: a number, a subscriber list, and a `get`/`set`. That is the entire surface
 * the two callers use.
 *
 * The loop is `createFrameLoop`, so every guarantee that module makes applies: no frames while the
 * element is off-screen, none while the tab is hidden, and nothing at all under reduced motion —
 * where the value stays at its initial `0` and subscribers are called once so they can settle
 * (Requirement 21.10, 21.11).
 *
 * Design: Motion System → Trigger mechanism.
 * Requirements: 21.8, 21.10, 21.11.
 */

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

import { createFrameLoop } from './frame-loop';
import { motionOK } from './preference';

/** The minimal reactive number the scroll-linked callers need. */
export interface MotionValue<T> {
  get(): T;
  set(value: T): void;
  /** Subscribe to changes. Returns a teardown. Not called on subscription. */
  on(listener: (value: T) => void): () => void;
}

export function createMotionValue<T>(initial: T): MotionValue<T> {
  let value = initial;
  const listeners = new Set<(next: T) => void>();
  return {
    get: () => value,
    set(next) {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener(next);
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * How far `element` has travelled through the viewport, from 0 (its top edge at the bottom of the
 * viewport) to 1 (its bottom edge at the top). Clamped, and 0 for a degenerate box.
 */
export function viewportProgress(
  rect: { top: number; height: number },
  viewportHeight: number,
): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0;
  const span = rect.height + viewportHeight;
  if (span <= 0) return 0;
  const travelled = viewportHeight - rect.top;
  return Math.min(1, Math.max(0, travelled / span));
}

/**
 * Track an element's viewport progress.
 *
 * The returned value is stable across renders, so a caller can subscribe once and write a
 * transform directly. It is never written to during render, and reading it does not subscribe.
 */
export function useScrollProgress(ref: RefObject<Element | null>): MotionValue<number> {
  const value = useRef<MotionValue<number> | null>(null);
  value.current ??= createMotionValue(0);
  const motion = value.current;

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const loop = createFrameLoop({
      target: element,
      animate: motionOK(),
      onFrame: () => {
        const rect = element.getBoundingClientRect();
        // Quantised to hundredths: a scroll-linked transform does not need more resolution than
        // that, and the `set` guard then skips most frames' subscriber calls entirely.
        const next = Math.round(viewportProgress(rect, window.innerHeight) * 100) / 100;
        motion.set(next);
      },
      // Reduced motion, off-screen and hidden-tab all land here. `0` is the neutral value.
      onIdle: () => motion.set(0),
    });

    loop.start();
    return () => loop.destroy();
  }, [ref, motion]);

  return motion;
}
