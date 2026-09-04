/**
 * The before/after room transformation slider.
 *
 * The design's brief is a draggable `clip-path` divider over two `AnimatedRoom` compositions, and
 * Requirement 21.11 adds the constraint that matters most: under reduced motion it "stays fully
 * functional as a draggable control with no easing". So this is not a motion feature that degrades
 * to nothing — it is a **control** whose easing is the only part that is motion.
 *
 * That shapes the module:
 *
 * - **Position is a number from 0 to 100** and every input path — pointer, keyboard, the initial
 *   value — goes through `clampPosition`. There is no code path that can set an out-of-range
 *   divider.
 * - **The keyboard path is not an afterthought.** `positionFromKey` implements the full ARIA
 *   slider contract: arrows, Page Up/Down, Home and End. A drag control that only works with a
 *   pointer fails Requirement 24.5 outright, and a room comparison is exactly the kind of content
 *   someone would want to step through slowly.
 * - **`clip-path`, not width.** `clipFor` returns an `inset()` string. Animating width would
 *   relayout on every frame and is forbidden by Requirement 21.8.
 * - **Easing is a CSS class, added only when motion is allowed.** The frame loop writes the
 *   `clip-path`; whether that write is eased is the stylesheet's business, gated on an attribute.
 *   So the reduced-motion version is the same control with the transition rule switched off, not a
 *   second implementation.
 *
 * Design: Motion System → The animated 2D component set (before/after room transformation slider).
 * Requirements: 21.6, 21.8, 21.11, 24.5.
 */

/** Percentage of the width shown of the "after" state. 50 is the middle. */
export const DEFAULT_POSITION = 50;

/** One arrow press. */
export const STEP = 2;

/** One Page Up/Down press. */
export const PAGE_STEP = 10;

/** Clamp to the slider's range and round to a whole percent. */
export function clampPosition(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_POSITION;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * The position a pointer at `clientX` implies, given the control's box.
 *
 * A zero-width box returns the current position rather than dividing by zero — which happens for
 * real when the control is measured before layout, or while it is inside a `display: none`
 * ancestor.
 */
export function positionFromPointer(
  clientX: number,
  box: { left: number; width: number },
  current: number = DEFAULT_POSITION,
): number {
  if (!Number.isFinite(clientX) || box.width <= 0) return clampPosition(current);
  return clampPosition(((clientX - box.left) / box.width) * 100);
}

/**
 * The position a key press implies, or `null` when the key is not ours.
 *
 * Returning `null` rather than the unchanged position is what lets the caller decide whether to
 * call `preventDefault()`: swallowing Tab or Enter here would trap the visitor in the control.
 */
export function positionFromKey(key: string, current: number): number | null {
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return clampPosition(current - STEP);
    case 'ArrowRight':
    case 'ArrowUp':
      return clampPosition(current + STEP);
    case 'PageDown':
      return clampPosition(current - PAGE_STEP);
    case 'PageUp':
      return clampPosition(current + PAGE_STEP);
    case 'Home':
      return 0;
    case 'End':
      return 100;
    default:
      return null;
  }
}

/**
 * The `clip-path` that reveals the "after" layer up to `position`.
 *
 * `inset()` from the right: at 0 the after layer is entirely clipped away, at 100 it covers the
 * before layer completely.
 */
export function clipFor(position: number): string {
  const clamped = clampPosition(position);
  return `inset(0 ${String(100 - clamped)}% 0 0)`;
}

/** Where the divider handle sits, as a percentage from the left. */
export function handleOffset(position: number): string {
  return `${String(clampPosition(position))}%`;
}

/**
 * The accessible value text.
 *
 * A bare "50" tells a screen-reader user nothing about a room comparison. Naming both states and
 * which one is showing is the difference between an operable control and a numeric mystery.
 */
export function valueText(position: number, beforeLabel: string, afterLabel: string): string {
  const clamped = clampPosition(position);
  if (clamped === 0) return `Showing ${beforeLabel} only`;
  if (clamped === 100) return `Showing ${afterLabel} only`;
  return `${String(clamped)}% ${afterLabel}, ${String(100 - clamped)}% ${beforeLabel}`;
}
