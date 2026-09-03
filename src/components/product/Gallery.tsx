/**
 * The product gallery.
 *
 * Three presentations of one sequence, chosen by CSS rather than by JavaScript, and one state
 * machine behind all three:
 *
 * - **≥ 1024 px** — a large primary image plus a thumbnail rail listing every image, with the
 *   current thumbnail marked. Activating a thumbnail swaps the primary with no navigation
 *   (Requirement 4.4).
 * - **768–1023 px** — a single primary image with position indicators and previous/next controls
 *   operable by pointer and by touch (4.14).
 * - **< 768 px** — the same sequence, swipeable, with indicators and ≥ 44 px touch controls (4.5).
 *
 * The breakpoint split is CSS because a JavaScript media query would make the server-rendered
 * markup wrong until hydration, and the rail is content — it must exist in the HTML.
 *
 * **Every image is a stacked layer, not a remount.** Swapping the primary by re-keying one `<img>`
 * would restart the LQIP-to-photograph transition on every change and would lose each image's
 * individual failure state. Instead all layers are rendered once; the inactive ones are
 * `visibility: hidden` and `loading="lazy"`, which browsers do not fetch until they are shown, so
 * the initial payload still carries exactly one image (Requirement 15.17, design → delivery
 * budget).
 *
 * **Load failure is per layer** (4.18): the failed layer paints its alt text inside its own
 * reserved box, the index does not move, and every other image stays navigable. The conversion
 * controls are not in this component at all, so nothing here can disable them.
 *
 * **Reduced motion** (4.17): the only motion is a cross-fade declared in `shell.css`, and it is
 * switched off by an explicit `prefers-reduced-motion` rule as well as by the global clamp — so
 * an image change is an instantaneous replacement.
 *
 * Requirements: 4.4, 4.5, 4.6, 4.14, 4.15, 4.16, 4.17, 4.18, 15.17, 15.18, 24.3, 24.5, 24.7.
 */

import { lazy, Suspense, useCallback, useRef, useState } from 'react';

import {
  applyGalleryKey,
  atFirst,
  atLast,
  initialGalleryState,
  markImageFailed,
  nextImage,
  openZoom,
  closeZoom,
  positionLabel,
  previousImage,
  selectImage,
  showsPositionIndicators,
  showsStepControls,
  showsThumbnailRail,
  zoomAvailable,
  type GalleryState,
} from '@/lib/products/gallery-state';
import { current as currentBatcher } from '@/lib/analytics/client';
import Skeleton from '@/components/ui/Skeleton';

/**
 * One image, with every URL already resolved on the server.
 *
 * The island receives strings rather than a `ProductImageValue` plus the srcset builders, so
 * `@/lib/images/srcset` and the derivative ladder never enter the client bundle.
 */
export interface GalleryImageProps {
  id: string;
  alt: string;
  /** Intrinsic dimensions, so each slot reserves its box before the bytes arrive. */
  width: number;
  height: number;
  src: string;
  srcSet: string;
  sizes: string;
  thumbSrc: string;
  /**
   * The thumbnail derivative's own dimensions.
   *
   * Not the original's: the rail serves a 320 px file, and declaring the 2400 px original's width
   * and height on it describes a file the browser is not fetching. The ratio would still be right,
   * so nothing shifted — but "intrinsic dimensions" means the dimensions of the image in `src`, and
   * a `width` that is off by an order of magnitude is exactly the kind of near-miss that stops
   * being harmless the moment a thumbnail is ever rendered at its own size.
   */
  thumbWidth: number;
  thumbHeight: number;
  lqip?: string;
  /** The largest derivative, for the zoom overlay (Requirement 4.6). */
  zoomSrc: string;
  zoomSrcSet: string;
}

export interface GalleryProps {
  images: readonly GalleryImageProps[];
  /** The product name, for accessible names that stand alone out of context. */
  productName: string;
  /** The product slug, so a zoom can be counted against the piece it was of. */
  productSlug?: string;
}

/** Below this many pixels of horizontal travel a touch is a tap or a scroll, not a swipe. */
export const SWIPE_THRESHOLD_PX = 40;

const GalleryZoom = lazy(async () => import('./GalleryZoom'));

export default function Gallery({
  images,
  productName,
  productSlug,
}: GalleryProps): React.JSX.Element | null {
  const [state, setState] = useState<GalleryState>(() => initialGalleryState(images.length));
  const openerRef = useRef<HTMLElement | null>(null);
  const touchStartX = useRef<number | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const current = images[state.index];
  const label = positionLabel(state);

  const close = useCallback(() => {
    setState((previous) => closeZoom(previous));
    // Requirement 4.6: focus returns to the control that opened zoom.
    openerRef.current?.focus();
  }, []);

  const open = useCallback(
    (opener: HTMLElement | null) => {
      if (opener !== null) openerRef.current = opener;
      setState((previous) => openZoom(previous));
      // Reported from here rather than from the button's click handler: the button is also
      // reachable by keyboard through the gallery's own key handling, and counting the click
      // would miss those openings entirely.
      currentBatcher()?.track('gallery_open', productSlug ?? '');
    },
    [productSlug],
  );

  /**
   * Keyboard, per Requirement 4.15.
   *
   * `Enter`/`Space` are left to the browser when focus is on another control inside the gallery —
   * pressing Enter on the "next" button must advance, not open zoom. Arrow keys do nothing native
   * on a button, so they are always ours.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      const isActivation = event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar';
      if (
        isActivation &&
        target !== null &&
        target.closest('button,a,[role="button"]') !== null &&
        target.closest('[data-ngf-gallery-primary]') === null
      ) {
        return;
      }

      const result = applyGalleryKey(state, event.key);
      // `handled === false` covers both "not a gallery key" and "no action at this end", which is
      // exactly what 4.15 asks for: the page keeps its default behaviour either way.
      if (!result.handled) return;
      event.preventDefault();
      if (result.state.zoomed && !state.zoomed) openerRef.current = target;
      setState(result.state);
    },
    [state],
  );

  const onTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  }, []);

  const onTouchEnd = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const start = touchStartX.current;
    touchStartX.current = null;
    if (start === null) return;
    const end = event.changedTouches[0]?.clientX;
    if (end === undefined) return;
    const travel = end - start;
    if (Math.abs(travel) < SWIPE_THRESHOLD_PX) return;
    setState((previous) => (travel < 0 ? nextImage(previous) : previousImage(previous)));
  }, []);

  if (images.length === 0 || current === undefined) return null;

  const rail = showsThumbnailRail(state);
  const indicators = showsPositionIndicators(state);
  const steps = showsStepControls(state);

  return (
    <div
      className="ngf-gallery"
      data-total={state.total}
      data-index={state.index}
      onKeyDown={onKeyDown}
    >
      <div
        ref={stageRef}
        className="ngf-gallery-stage"
        role="group"
        aria-label={`${productName} photographs`}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {images.map((image, index) => (
          <figure
            key={image.id}
            className="ngf-gallery-layer"
            data-current={index === state.index ? 'true' : 'false'}
            data-failed={state.failed.has(index) ? 'true' : 'false'}
            aria-hidden={index === state.index ? undefined : 'true'}
            style={image.lqip === undefined ? undefined : { backgroundImage: `url(${image.lqip})` }}
          >
            <img
              src={image.src}
              srcSet={image.srcSet}
              sizes={image.sizes}
              width={image.width}
              height={image.height}
              alt={image.alt}
              loading={index === 0 ? 'eager' : 'lazy'}
              fetchPriority={index === 0 ? 'high' : 'auto'}
              decoding={index === 0 ? 'sync' : 'async'}
              onError={() => setState((previous) => markImageFailed(previous, index))}
            />
            {/*
              The alt-text tile. Always present so it needs no script to appear and occupies the
              same reserved box as the photograph — a failure shifts nothing (Requirement 4.18).
            */}
            <figcaption className="ngf-gallery-fallback" aria-hidden="true">
              {image.alt.trim() === '' ? 'Photograph unavailable' : image.alt}
            </figcaption>
          </figure>
        ))}

        {zoomAvailable(state) && (
          <button
            type="button"
            data-ngf-gallery-primary
            className="ngf-gallery-zoom-open"
            onClick={(event) => open(event.currentTarget)}
            aria-label={`Zoom ${label.toLowerCase()} of ${productName}`}
          >
            <span aria-hidden="true">＋</span>
          </button>
        )}

        {steps && (
          <>
            <button
              type="button"
              className="ngf-gallery-step ngf-gallery-prev"
              onClick={() => setState(previousImage)}
              disabled={atFirst(state)}
              aria-label="Previous image"
            >
              <span aria-hidden="true">‹</span>
            </button>
            <button
              type="button"
              className="ngf-gallery-step ngf-gallery-next"
              onClick={() => setState(nextImage)}
              disabled={atLast(state)}
              aria-label="Next image"
            >
              <span aria-hidden="true">›</span>
            </button>
          </>
        )}
      </div>

      {/*
        The position and total, exposed to assistive technology at every width (Requirement 4.15)
        and painted as the visible indicator below 1024 px, where there is no rail to mark
        (4.5, 4.14). One element, so the spoken and the seen text cannot drift.
      */}
      <p className="ngf-gallery-position" role="status">
        {label}
      </p>

      {indicators && (
        <ul className="ngf-gallery-dots" aria-hidden="true">
          {images.map((image, index) => (
            <li key={image.id} data-current={index === state.index ? 'true' : 'false'} />
          ))}
        </ul>
      )}

      {rail && (
        <ul className="ngf-gallery-rail">
          {images.map((image, index) => (
            <li key={image.id}>
              <button
                type="button"
                onClick={() => setState((previous) => selectImage(previous, index))}
                aria-current={index === state.index ? 'true' : undefined}
                aria-label={`Show image ${index + 1} of ${state.total}`}
                className="ngf-gallery-thumb"
                data-current={index === state.index ? 'true' : 'false'}
              >
                <img
                  src={image.thumbSrc}
                  width={image.thumbWidth}
                  height={image.thumbHeight}
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
              </button>
            </li>
          ))}
        </ul>
      )}

      {state.zoomed && (
        /*
         * Requirement 26.12: the overlay is opened deliberately, so between the tap and the chunk
         * arriving it must show the shape of what is coming — not the blank dark surface a `null`
         * fallback left. The skeleton reserves the photograph's own aspect ratio, so the image
         * replaces it without moving anything, and on a fast connection it is never seen.
         */
        <Suspense
          fallback={
            <div className="ngf-gallery-zoom" data-surface="dark" role="presentation">
              <Skeleton
                variant="image"
                ratio={`${current.width} / ${current.height}`}
                className="ngf-gallery-zoom-loading"
              />
            </div>
          }
        >
          <GalleryZoom
            src={current.zoomSrc}
            srcSet={current.zoomSrcSet}
            alt={current.alt}
            width={current.width}
            height={current.height}
            label={label}
            onClose={close}
          />
        </Suspense>
      )}
    </div>
  );
}
