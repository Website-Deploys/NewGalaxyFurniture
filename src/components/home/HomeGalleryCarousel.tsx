/**
 * The homepage Gallery carousel.
 *
 * A single-piece showcase, matching the reference: an eyebrow and display heading on the left, a
 * "01 / 04" counter and prev/next controls on the right, one large image below, and a thumbnail
 * rail that selects the visible frame. It shows the site's flagship set from every angle — the
 * same photographs the product page carries — and the whole band links to that piece.
 *
 * The images arrive as already-resolved URL strings from the server (`GallerySection.astro`), so
 * the srcset builders and derivative ladder never enter the client bundle. Every frame is lazy and
 * async: the homepage's one prioritised image is the hero above, and this band is well below the
 * fold, so nothing here competes with it for early bandwidth.
 *
 * Interaction is keyboard-complete: the prev/next buttons and each thumbnail are real buttons, the
 * active frame is announced with `aria-current`, and left/right arrow keys on the viewport move
 * between frames. Under reduced motion the cross-fade is switched off by the stylesheet.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';

export interface HomeGalleryImage {
  /** Stable key, unique within the carousel. */
  id: string;
  src: string;
  /** Optional responsive candidates; when equal to `src` the carousel serves `src` alone. */
  srcSet?: string;
  sizes?: string;
  alt: string;
  width: number;
  height: number;
  /** Short caption title, e.g. "Front View". */
  title: string;
  lqip?: string;
}

export interface HomeGalleryCarouselProps {
  eyebrow?: string;
  heading: string;
  headingId: string;
  subheading: string;
  /** The product this gallery shows, linked from the whole band. */
  productHref: string;
  productName: string;
  images: readonly HomeGalleryImage[];
}

function ChevronLeft(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

function ChevronRight(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

/** Two-digit index, so the counter reads "01 / 04" rather than "1 / 4". */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export default function HomeGalleryCarousel({
  eyebrow,
  heading,
  headingId,
  subheading,
  productHref,
  productName,
  images,
}: HomeGalleryCarouselProps): React.JSX.Element {
  const [active, setActive] = useState(0);
  const count = images.length;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const groupId = useId();

  const go = useCallback(
    (next: number) => {
      if (count === 0) return;
      setActive(((next % count) + count) % count);
    },
    [count],
  );

  const prev = useCallback(() => go(active - 1), [active, go]);
  const next = useCallback(() => go(active + 1), [active, go]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        prev();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        next();
      }
    },
    [prev, next],
  );

  // Keep the active thumbnail scrolled into view on narrow screens where the rail scrolls.
  const railRef = useRef<HTMLUListElement | null>(null);
  useEffect(() => {
    const rail = railRef.current;
    if (rail === null) return;
    const el = rail.querySelector<HTMLElement>(`[data-thumb-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  if (count === 0) return <></>;

  const current = images[active]!;

  return (
    <div className="ngf-home-gallery-card">
      <div className="ngf-hg-top">
        <header className="ngf-hg-head">
          {eyebrow !== undefined && <p className="ngf-hg-eyebrow">{eyebrow}</p>}
          <h2 className="ngf-hg-heading" id={headingId}>
            {heading}
          </h2>
          <p className="ngf-hg-sub">{subheading}</p>
        </header>

        <div className="ngf-hg-controls">
          <span className="ngf-hg-counter" aria-hidden="true">
            {pad2(active + 1)} / {pad2(count)}
          </span>
          <div className="ngf-hg-arrows">
            <button
              type="button"
              className="ngf-hg-arrow"
              onClick={prev}
              aria-label="Previous photograph"
              aria-controls={groupId}
            >
              <ChevronLeft />
            </button>
            <button
              type="button"
              className="ngf-hg-arrow"
              onClick={next}
              aria-label="Next photograph"
              aria-controls={groupId}
            >
              <ChevronRight />
            </button>
          </div>
        </div>
      </div>

      <div
        className="ngf-hg-viewport"
        id={groupId}
        ref={viewportRef}
        role="group"
        aria-roledescription="carousel"
        aria-label={`${productName} — photograph ${active + 1} of ${count}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <a
          className="ngf-hg-stage"
          href={productHref}
          aria-label={`View ${productName} — ${current.title}`}
        >
          {images.map((image, index) => (
            <img
              key={image.id}
              className="ngf-hg-img"
              src={image.src}
              srcSet={image.srcSet !== undefined && image.srcSet !== image.src ? image.srcSet : undefined}
              sizes={image.srcSet !== undefined && image.srcSet !== image.src ? image.sizes : undefined}
              width={image.width}
              height={image.height}
              alt={image.alt}
              loading="lazy"
              decoding="async"
              data-active={index === active ? 'true' : 'false'}
              aria-hidden={index === active ? undefined : 'true'}
              style={image.lqip === undefined ? undefined : { backgroundImage: `url(${image.lqip})` }}
            />
          ))}
        </a>
      </div>

      <ul className="ngf-hg-thumbs" ref={railRef} aria-label={`${productName} photographs`}>
        {images.map((image, index) => (
          <li key={image.id} className="ngf-hg-thumb-item" data-thumb-index={index}>
            <button
              type="button"
              className="ngf-hg-thumb"
              data-active={index === active ? 'true' : 'false'}
              aria-current={index === active ? 'true' : undefined}
              aria-label={`Show ${image.title} (${index + 1} of ${count})`}
              onClick={() => setActive(index)}
            >
              <img
                className="ngf-hg-thumb-img"
                src={image.src}
                width={image.width}
                height={image.height}
                alt=""
                loading="lazy"
                decoding="async"
              />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
