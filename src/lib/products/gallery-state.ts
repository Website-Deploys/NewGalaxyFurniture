/**
 * The gallery's state machine, as a pure reducer.
 *
 * The gallery is the most behaviourally dense component on the public site: three responsive
 * presentations, keyboard navigation with hard stops at both ends, a focus-trapping zoom overlay
 * that must return focus to its opener, per-image load failure that must not disturb navigation,
 * and a reduced-motion path. Requirements 4.4, 4.5, 4.6, 4.14, 4.15, 4.16, 4.17, and 4.18 all
 * describe parts of it.
 *
 * Every one of those rules that is a *decision* rather than a *rendering* lives here, in a module
 * with no React and no DOM, for two reasons. First, it can be tested directly and exhaustively —
 * "ArrowLeft at the first image takes no action" is a one-line assertion against a function, and
 * an untestable assertion against a rendered component. Second, the component cannot then
 * disagree with the requirement by accident, because it holds no logic of its own to disagree
 * with.
 *
 * **No-ops return the identical state object.** That is load-bearing rather than an optimisation:
 * Requirement 4.15 says ArrowLeft at the first image and ArrowRight at the last "take no action",
 * and the island decides whether to call `preventDefault` by asking whether the reducer moved. If
 * a no-op returned a fresh equal object, the gallery would swallow the key press and the page
 * would stop scrolling at the ends of the rail.
 *
 * Requirements: 4.4, 4.5, 4.6, 4.14, 4.15, 4.16, 4.17, 4.18.
 * Design: Catalogue → Product cards, PDP, and related products.
 */

export interface GalleryState {
  /** The displayed image's zero-based index. Always in `[0, total)` when `total > 0`. */
  readonly index: number;
  /** How many images the product has. */
  readonly total: number;
  /** Whether the zoom / fullscreen view is open. */
  readonly zoomed: boolean;
  /**
   * Indices whose image failed to load.
   *
   * Kept as a set of indices rather than removing the image, because Requirement 4.18 requires
   * the remaining images to stay navigable *and* the failed slot to keep its reserved box: an
   * image that failed is still a position in the sequence, it just paints its alt text.
   */
  readonly failed: ReadonlySet<number>;
}

export type GalleryAction =
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'select'; index: number }
  | { type: 'openZoom' }
  | { type: 'closeZoom' }
  | { type: 'imageFailed'; index: number };

export function initialGalleryState(total: number): GalleryState {
  return {
    index: 0,
    total: Math.max(0, Math.trunc(total)),
    zoomed: false,
    failed: new Set<number>(),
  };
}

/* -------------------------------------------------------------------------- */
/* Presentation predicates                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Requirement 4.16, stated once. A single-image product shows the image alone: no thumbnail rail
 * (4.4), no position indicators (4.5, 4.14), no previous/next controls (4.5, 4.14).
 *
 * A zero-image product is treated the same way — there is nothing to step between — and the
 * component renders its designed "no photograph yet" slot instead.
 */
export function hasMultipleImages(state: Pick<GalleryState, 'total'>): boolean {
  return state.total > 1;
}

export const showsThumbnailRail = hasMultipleImages;
export const showsPositionIndicators = hasMultipleImages;
export const showsStepControls = hasMultipleImages;

/**
 * Zoom is operable for a single image too (Requirement 4.16's final clause), and for a failed
 * one — the overlay requests the largest derivative, which may well succeed where the inline
 * candidate did not. It is only meaningless with no images at all.
 */
export function zoomAvailable(state: Pick<GalleryState, 'total'>): boolean {
  return state.total > 0;
}

export function atFirst(state: Pick<GalleryState, 'index'>): boolean {
  return state.index <= 0;
}

export function atLast(state: Pick<GalleryState, 'index' | 'total'>): boolean {
  return state.index >= state.total - 1;
}

/**
 * The position and total, as a sentence, for the indicator and for assistive technology
 * (Requirements 4.5, 4.14, 4.15). One string so the visible text and the accessible name cannot
 * drift apart.
 */
export function positionLabel(state: Pick<GalleryState, 'index' | 'total'>): string {
  if (state.total <= 0) return 'No images';
  return `Image ${state.index + 1} of ${state.total}`;
}

/* -------------------------------------------------------------------------- */
/* Transitions                                                                */
/* -------------------------------------------------------------------------- */

/** ArrowRight / swipe left / "next". No action at the last image (Requirement 4.15). */
export function nextImage(state: GalleryState): GalleryState {
  if (atLast(state)) return state;
  return { ...state, index: state.index + 1 };
}

/** ArrowLeft / swipe right / "previous". No action at the first image (Requirement 4.15). */
export function previousImage(state: GalleryState): GalleryState {
  if (atFirst(state)) return state;
  return { ...state, index: state.index - 1 };
}

/**
 * Activating a thumbnail (Requirement 4.4).
 *
 * An out-of-range index is a no-op rather than a clamp: clamping would silently show a different
 * image than the one activated, which is worse than doing nothing.
 */
export function selectImage(state: GalleryState, index: number): GalleryState {
  if (!Number.isInteger(index) || index < 0 || index >= state.total) return state;
  if (index === state.index) return state;
  return { ...state, index };
}

export function openZoom(state: GalleryState): GalleryState {
  if (state.zoomed || !zoomAvailable(state)) return state;
  return { ...state, zoomed: true };
}

export function closeZoom(state: GalleryState): GalleryState {
  if (!state.zoomed) return state;
  return { ...state, zoomed: false };
}

/**
 * Record a load failure (Requirement 4.18).
 *
 * The index is untouched: a failed image does not advance the gallery, because advancing would
 * move the visitor away from the image they asked for and would cascade if several failed.
 */
export function markImageFailed(state: GalleryState, index: number): GalleryState {
  if (!Number.isInteger(index) || index < 0 || index >= state.total) return state;
  if (state.failed.has(index)) return state;
  const failed = new Set(state.failed);
  failed.add(index);
  return { ...state, failed };
}

export function reduceGallery(state: GalleryState, action: GalleryAction): GalleryState {
  switch (action.type) {
    case 'next':
      return nextImage(state);
    case 'previous':
      return previousImage(state);
    case 'select':
      return selectImage(state, action.index);
    case 'openZoom':
      return openZoom(state);
    case 'closeZoom':
      return closeZoom(state);
    case 'imageFailed':
      return markImageFailed(state, action.index);
  }
}

/* -------------------------------------------------------------------------- */
/* Keyboard mapping                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The keyboard contract of Requirement 4.15, as a lookup from key to action.
 *
 * `Escape` maps to `closeZoom` here as well as being handled by the focus trap, so the mapping
 * is complete on its own terms and can be asserted without a DOM.
 *
 * Every other key returns `null`, which the island reads as "not ours" and leaves alone — so
 * Tab still moves focus, Home/End still scroll, and a screen reader's own keys still work.
 */
export function galleryKeyAction(key: string): GalleryAction | null {
  switch (key) {
    case 'ArrowLeft':
      return { type: 'previous' };
    case 'ArrowRight':
      return { type: 'next' };
    case 'Enter':
    case ' ':
    case 'Spacebar': // legacy key name, still emitted by some Android keyboards
      return { type: 'openZoom' };
    case 'Escape':
      return { type: 'closeZoom' };
    default:
      return null;
  }
}

/**
 * Apply a key press. Returns the next state and whether the gallery consumed the key.
 *
 * `handled: false` for a key the gallery recognises but that produced no change is exactly the
 * "no action at either end" rule: the gallery did not move, so it must not claim the key either,
 * and the browser's default (scrolling the page) stands.
 */
export function applyGalleryKey(
  state: GalleryState,
  key: string,
): { state: GalleryState; handled: boolean } {
  const action = galleryKeyAction(key);
  if (action === null) return { state, handled: false };
  const next = reduceGallery(state, action);
  return { state: next, handled: next !== state };
}
