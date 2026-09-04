/**
 * The motion runtime: one entry point, booted once per page.
 *
 * Everything the motion system does at runtime starts here, and the module exists so that the
 * budget in Requirement 21.15 has something to be measured against. `MotionRuntime.astro` is its
 * only `<script>`, so the bundler emits it as one chunk and `size-limit` can hold that chunk to
 * 14 KB Brotli — a budget spread across six lazily-imported files would be a budget nobody could
 * check.
 *
 * What it boots, in order of how little it costs:
 *
 * 1. **The reveal controller.** One IntersectionObserver for the whole page, or none at all under
 *    reduced motion (in which case every `[data-reveal]` element is marked revealed on the spot).
 * 2. **The hero parallax**, only when a `[data-parallax-root]` is present — so every page but the
 *    homepage skips it without a check of its own.
 * 3. **The before/after slider**, same conditional, and only for the one page that carries one.
 *
 * The two rAF consumers are the design's only two, and both go through `createFrameLoop`, which
 * cannot run off-screen or in a hidden tab.
 *
 * **Reduced motion is decided once, here.** Every downstream module takes `animate` as a
 * parameter rather than asking, so there is exactly one read of the preference per page load and
 * exactly one place where the OR of the media query and the visitor's toggle happens.
 *
 * **The preference is watched.** A visitor who presses the footer toggle mid-visit gets the
 * planes flattened and the loops stopped immediately, without a reload.
 *
 * Design: Motion System → Trigger mechanism, Reduced motion, Keeping motion inside the budget.
 * Requirements: 21.8, 21.10, 21.11, 21.12, 21.13, 21.15.
 */

import { applyParallax, flattenParallax, readPlanes, type ParallaxPlane } from './parallax';
import { createFrameLoop, type FrameLoop } from './frame-loop';
import { createRevealController, type RevealController } from './reveal';
import { installBeforeAfter, type BeforeAfterInstance } from './before-after-control';
import { motionOK, onMotionChange } from './preference';

/** The hero marks itself with this so the runtime need not know which page it is on. */
export const PARALLAX_ROOT_ATTRIBUTE = 'data-parallax-root';

let controller: RevealController | null = null;
let heroLoop: FrameLoop | null = null;
let heroPlanes: readonly ParallaxPlane[] = [];
let sliders: BeforeAfterInstance[] = [];
let unwatch: (() => void) | null = null;
let booted = false;

/**
 * The page's shared reveal controller, for `useReveal`.
 *
 * Returns null before boot. Callers treat that as "reveal immediately", never as "wait" — content
 * must not depend on a script having arrived.
 */
export function sharedRevealController(): RevealController | null {
  return controller;
}

function bootParallax(animate: boolean): void {
  const hero = document.querySelector(`[${PARALLAX_ROOT_ATTRIBUTE}]`);
  if (hero === null) return;

  heroPlanes = readPlanes(hero);
  if (heroPlanes.length === 0) return;

  heroLoop = createFrameLoop({
    target: hero,
    animate,
    promote: heroPlanes.map((plane) => plane.element),
    onFrame: () => applyParallax(hero, heroPlanes),
    // Requirement 7.11 / 21.11: the planes hold their neutral position. This runs on the
    // reduced-motion path, when the hero leaves the viewport, and when the tab is hidden.
    onIdle: () => flattenParallax(heroPlanes),
  });
  heroLoop.start();
}

/** Boot the motion system. Idempotent — a second call does nothing. */
export function bootMotion(): void {
  if (booted) return;
  booted = true;

  const animate = motionOK();

  controller = createRevealController({ animate });
  controller.observeAll(document);

  bootParallax(animate);
  sliders = installBeforeAfter(document, animate);

  // Mid-visit changes. Turning motion *off* must take effect at once; turning it back on waits
  // for the next navigation, because retro-animating a page someone is reading would be worse
  // than a page that stays calm until they move.
  unwatch = onMotionChange((allowed) => {
    if (allowed) return;
    heroLoop?.stop();
    flattenParallax(heroPlanes);
    for (const slider of sliders) slider.setEasing(false);
    // Anything still waiting to reveal is revealed now, in its final state, rather than left in
    // its from-state for the rest of the visit.
    controller?.destroy();
    controller = createRevealController({ animate: false });
    controller.observeAll(document);
  });
}

/** Release everything. Exists for tests and for a future view transition. */
export function teardownMotion(): void {
  heroLoop?.destroy();
  heroLoop = null;
  flattenParallax(heroPlanes);
  heroPlanes = [];
  for (const slider of sliders) slider.destroy();
  sliders = [];
  controller?.destroy();
  controller = null;
  unwatch?.();
  unwatch = null;
  booted = false;
}
