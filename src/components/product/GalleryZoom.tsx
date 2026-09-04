/**
 * The zoom / fullscreen overlay.
 *
 * A separate module, loaded by `Gallery` with a dynamic `import()` on first open, because
 * Requirement 4.6 says zoom shows "the largest available Derivative" and the design's delivery
 * budget says the PDP must not pay for that up front. Nothing here — not the markup, not the
 * focus trap wiring, not the 2000 px candidate — is in the initial payload.
 *
 * Focus behaviour is the whole reason this is a real dialog rather than a styled `div`:
 *
 * - Focus is confined while it is open, through the shared trap.
 * - `Escape` and the close control both close it, and **the caller** restores focus to the
 *   control that opened it (Requirement 4.6). This component deliberately does not guess the
 *   opener; it just reports that it wants to close.
 *
 * Requirements: 4.6, 24.5, 24.7.
 */

import { useEffect, useRef } from 'react';

import { activateTrap } from '@/lib/ui/focus-trap';

export interface GalleryZoomProps {
  /** The largest derivative for the displayed image. */
  src: string;
  srcSet: string;
  alt: string;
  width: number;
  height: number;
  /** "Image 2 of 5" — the accessible name of the dialog. */
  label: string;
  onClose: () => void;
}

export default function GalleryZoom({
  src,
  srcSet,
  alt,
  width,
  height,
  label,
  onClose,
}: GalleryZoomProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    return activateTrap(dialog, { onEscape: onClose, initialFocus: closeRef.current });
  }, [onClose]);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${label}, zoomed`}
      className="ngf-gallery-zoom"
      data-surface="dark"
    >
      <button
        type="button"
        ref={closeRef}
        onClick={onClose}
        className="ngf-gallery-zoom-close"
        data-ngf-gallery-zoom-close
      >
        <span aria-hidden="true">×</span>
        <span className="sr-only">Close zoomed image</span>
      </button>

      <img
        src={src}
        srcSet={srcSet}
        sizes="100vw"
        width={width}
        height={height}
        alt={alt}
        decoding="async"
        className="ngf-gallery-zoom-image"
      />

      <p className="ngf-gallery-zoom-caption">{label}</p>
    </div>
  );
}
