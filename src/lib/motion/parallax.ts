/**
 * The hero's three-plane parallax.
 *
 * The geometry is a pure function, which is the point of splitting this file from the loop that
 * drives it: `planeOffset` is the whole of the parallax and it is testable without a viewport, a
 * scroll position, or a frame.
 *
 * Three constraints from the design and the requirements, all visible in the signature:
 *
 * - **`translate3d` only.** `planeTransform` returns a `translate3d(0, …px, 0)` string and nothing
 *   else. There is no scale, no opacity, no filter — so there is no way for a caller to animate a
 *   property Requirement 21.8 forbids.
 * - **Three planes, and the copy plane barely moves.** The depths are declared per plane in the
 *   hero's markup as `--plane-depth`; the nearest plane (type and the three CTAs) has the largest
 *   depth but the offset is *clamped*, because text that slides under a finger is text that is
 *   hard to read and hard to tap.
 * - **Neutral is `0`.** `planeOffset` returns 0 when the hero is at its rest position *and* when
 *   the input is nonsense (a zero-height viewport, a NaN scroll). So the flattened
 *   reduced-motion state and the "something went wrong" state are the same state, and it is the
 *   state the hero already renders (Requirement 21.11).
 *
 * Design: Motion System → The animated 2D component set (parallax layers, three depth planes,
 * `translate3d` only).
 * Requirements: 7.6, 7.11, 21.8, 21.10, 21.11.
 */

/** The attribute the hero marks each plane with. */
export const PLANE_ATTRIBUTE = 'data-parallax-plane';

/** The custom property each plane declares its depth in. */
export const PLANE_DEPTH_PROPERTY = '--plane-depth';

/**
 * The furthest any plane may travel, in pixels.
 *
 * A hard cap rather than a pure multiple of scroll distance: on a tall phone the hero can be
 * scrolled by more than its own height, and an unclamped offset would drag a plane clear of its
 * container. 48 px is enough to read as depth and small enough that no plane ever separates from
 * the composition.
 */
export const MAX_PLANE_OFFSET_PX = 48;

export interface ParallaxInput {
  /** The hero's top edge relative to the viewport, as `getBoundingClientRect().top` reports it. */
  heroTop: number;
  /** The hero's own height. */
  heroHeight: number;
  /** The viewport height. */
  viewportHeight: number;
}

/**
 * How far the hero has travelled through its own parallax range, from 0 to 1.
 *
 * 0 is "the hero's top edge is at the top of the viewport" — its rest position on load — and 1 is
 * "the hero has scrolled entirely past". Values outside that are clamped, so a bounce-scroll
 * overshoot cannot push a plane beyond its range.
 */
export function parallaxProgress(input: ParallaxInput): number {
  const { heroTop, heroHeight, viewportHeight } = input;
  if (!Number.isFinite(heroTop) || !Number.isFinite(heroHeight) || heroHeight <= 0) return 0;
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0;
  // Travelled distance, measured from the rest position.
  const travelled = -heroTop;
  const range = heroHeight;
  const progress = travelled / range;
  return Math.min(1, Math.max(0, progress));
}

/**
 * The vertical offset for one plane, in pixels.
 *
 * Positive depth moves the plane *up* as the page scrolls down — the deeper the plane, the less it
 * moves, which is what reads as distance. A depth of 0 pins a plane to the page.
 */
export function planeOffset(progress: number, depth: number): number {
  if (!Number.isFinite(progress) || !Number.isFinite(depth)) return 0;
  const clampedProgress = Math.min(1, Math.max(0, progress));
  const clampedDepth = Math.min(1, Math.max(0, depth));
  const offset = -clampedProgress * clampedDepth * MAX_PLANE_OFFSET_PX;
  // Rounded to a whole pixel: a sub-pixel transform on a text plane costs a re-raster per frame
  // for a difference nobody can see. `|| 0` normalises negative zero, which `Math.round` produces
  // for any small negative input and which would otherwise emit `translate3d(0, -0px, 0)`.
  const rounded = Math.round(offset);
  return rounded === 0 ? 0 : rounded;
}

/** The only transform string this module produces. */
export function planeTransform(offsetPx: number): string {
  return `translate3d(0, ${String(offsetPx)}px, 0)`;
}

/** The neutral transform every plane holds at rest and under reduced motion. */
export const NEUTRAL_TRANSFORM = planeTransform(0);

/* -------------------------------------------------------------------------- */
/* Browser wiring                                                             */
/* -------------------------------------------------------------------------- */

export interface ParallaxPlane {
  element: HTMLElement;
  depth: number;
}

/** Read the planes and their depths out of a hero section. */
export function readPlanes(hero: Element): ParallaxPlane[] {
  const planes: ParallaxPlane[] = [];
  for (const element of hero.querySelectorAll(`[${PLANE_ATTRIBUTE}]`)) {
    if (!(element instanceof HTMLElement)) continue;
    const declared = getComputedStyle(element).getPropertyValue(PLANE_DEPTH_PROPERTY).trim();
    const depth = Number.parseFloat(declared);
    planes.push({ element, depth: Number.isFinite(depth) ? depth : 0 });
  }
  // Three, per the design. A fourth in the markup would be a mistake worth seeing rather than
  // silently animating, so it is logged and dropped in development.
  if (planes.length > 3 && import.meta.env.DEV) {
    console.warn(
      `[motion] hero declares ${String(planes.length)} parallax planes; the design allows three`,
    );
  }
  return planes.slice(0, 3);
}

/** Write every plane's transform for the current scroll position. */
export function applyParallax(hero: Element, planes: readonly ParallaxPlane[]): void {
  const rect = hero.getBoundingClientRect();
  const progress = parallaxProgress({
    heroTop: rect.top,
    heroHeight: rect.height,
    viewportHeight: window.innerHeight,
  });
  for (const plane of planes) {
    plane.element.style.transform = planeTransform(planeOffset(progress, plane.depth));
  }
}

/** Return every plane to neutral. The reduced-motion state, and the teardown state. */
export function flattenParallax(planes: readonly ParallaxPlane[]): void {
  for (const plane of planes) plane.element.style.transform = NEUTRAL_TRANSFORM;
}
