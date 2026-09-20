/**
 * The gallery board — one product's photographs, organised, filterable, and openable.
 *
 * The `/gallery` route resolves every Catalogue image into a `GalleryTile` (URLs already built on
 * the server, exactly as `Gallery` receives them) and groups the tiles by product. This island
 * renders one *board* per product: a header naming the piece, category filter tabs with live
 * counts, and a bento grid of the tiles. So the page scales to the whole catalogue with no manual
 * authoring — a new product's photographs appear the next build, in their own board.
 *
 * Three behaviours the reference calls for, all here:
 *
 * - **Filter tabs** — All / Room Views / Angles / Details, each with its count, filtering the grid
 *   in place with no navigation. A category with zero tiles is shown but disabled, so the set of
 *   tabs is honest about what exists.
 * - **Hover** — the image lifts a subtle zoom and its caption strengthens; declared here and
 *   switched off under reduced motion by the stylesheet.
 * - **Open** — the whole tile is a link to the product page (pointer and keyboard), and a separate
 *   expand control opens the photograph in the shared zoom overlay without navigating. The two
 *   targets never collide: the expand button sits above the link and stops the click.
 *
 * The zoom overlay is loaded on first open with a dynamic import, so the lightbox code is not in
 * the initial payload — the same discipline the PDP gallery uses.
 */

import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';

const GalleryZoom = lazy(async () => import('@/components/product/GalleryZoom'));

/** A gallery category, derived from a tile's alt text on the server. */
export type GalleryCategory = 'room' | 'angle' | 'detail';

export interface GalleryTile {
  /** Stable key, unique across the whole page. */
  id: string;
  productSlug: string;
  productName: string;
  href: string;
  category: GalleryCategory;
  /** Short overlay title, e.g. "Front View". */
  title: string;
  /** Overlay subtitle, e.g. "Complete set in a modern living room". */
  subtitle: string;
  alt: string;
  width: number;
  height: number;
  src: string;
  srcSet: string;
  sizes: string;
  lqip?: string;
  /** Largest derivative, for the zoom overlay. */
  zoomSrc: string;
  zoomSrcSet: string;
}

export interface GalleryBoardProps {
  productName: string;
  productSlug: string;
  productHref: string;
  /** Optional intro line under the product name. */
  intro?: string;
  tiles: readonly GalleryTile[];
  /** The WhatsApp enquiry URL for the "See it in your space" card. */
  whatsappHref: string | null;
  /**
   * The id of the one tile that is the whole page's largest contentful image. It is loaded eagerly
   * at high priority and is the image the page preloads; every other tile is lazy. Only the first
   * board on the page sets this, so there is exactly one prioritised image site-wide.
   */
  leadTileId?: string;
}

type Filter = 'all' | GalleryCategory;

const CATEGORY_ORDER: readonly GalleryCategory[] = ['room', 'angle', 'detail'];

const CATEGORY_LABEL: Record<GalleryCategory, string> = {
  room: 'Room Views',
  angle: 'Angles',
  detail: 'Details',
};

/** A small inline sofa glyph for the overlay captions — currentColor, decorative. */
function SofaGlyph(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 11h18" />
      <path d="M5 11V8.5A2 2 0 0 1 7 6.5h10a2 2 0 0 1 2 2V11" />
      <path d="M4 11a2 2 0 0 0-2 2v3h20v-3a2 2 0 0 0-2-2" />
      <path d="M4 18v1.5" />
      <path d="M20 18v1.5" />
    </svg>
  );
}

function ExpandGlyph(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5" />
    </svg>
  );
}

export default function GalleryBoard({
  productName,
  productHref,
  intro,
  tiles,
  whatsappHref,
  leadTileId,
}: GalleryBoardProps): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>('all');
  const [zoomIndex, setZoomIndex] = useState<number | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);

  /** Counts per category, plus the total, computed once. */
  const counts = useMemo(() => {
    const base: Record<Filter, number> = { all: tiles.length, room: 0, angle: 0, detail: 0 };
    for (const tile of tiles) base[tile.category] += 1;
    return base;
  }, [tiles]);

  const visible = useMemo(
    () => (filter === 'all' ? tiles : tiles.filter((tile) => tile.category === filter)),
    [filter, tiles],
  );

  const closeZoom = useCallback(() => {
    setZoomIndex(null);
    openerRef.current?.focus();
    openerRef.current = null;
  }, []);

  const openZoom = useCallback((index: number, opener: HTMLButtonElement | null) => {
    openerRef.current = opener;
    setZoomIndex(index);
  }, []);

  const zoomed = zoomIndex === null ? null : visible[zoomIndex];

  const tabs: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: counts.all },
    ...CATEGORY_ORDER.map((category) => ({
      key: category,
      label: CATEGORY_LABEL[category],
      count: counts[category],
    })),
  ];

  return (
    <section className="ngf-galb" aria-label={`${productName} gallery`}>
      <header className="ngf-galb-head">
        <p className="ngf-galb-eyebrow">Our gallery</p>
        <h1 className="ngf-galb-title">{productName}</h1>
        {intro !== undefined && <p className="ngf-galb-intro">{intro}</p>}

        <div className="ngf-galb-tabs" role="tablist" aria-label="Filter photographs">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={filter === tab.key}
              disabled={tab.count === 0 && tab.key !== 'all'}
              className="ngf-galb-tab"
              data-active={filter === tab.key ? 'true' : 'false'}
              onClick={() => setFilter(tab.key)}
            >
              <span className="ngf-galb-tab-label">{tab.label}</span>
              <span className="ngf-galb-tab-count">({tab.count})</span>
            </button>
          ))}
        </div>
      </header>

      {visible.length > 0 && (
        <ul className="ngf-galb-grid">
          {visible.map((tile, index) => (
            <li
              key={tile.id}
              className="ngf-galb-cell"
              data-span={index === 0 ? 'wide' : index === 3 ? 'wide' : 'one'}
            >
              <article className="ngf-galb-tile">
                <span className="ngf-galb-frame">
                  <img
                    src={tile.src}
                    srcSet={tile.srcSet === tile.src ? undefined : tile.srcSet}
                    sizes={tile.srcSet === tile.src ? undefined : tile.sizes}
                    width={tile.width}
                    height={tile.height}
                    alt={tile.alt}
                    loading={tile.id === leadTileId ? 'eager' : 'lazy'}
                    fetchPriority={tile.id === leadTileId ? 'high' : 'auto'}
                    decoding={tile.id === leadTileId ? 'sync' : 'async'}
                    className="ngf-galb-img"
                    style={
                      tile.lqip === undefined ? undefined : { backgroundImage: `url(${tile.lqip})` }
                    }
                  />
                </span>

                <span className="ngf-galb-caption">
                  <span className="ngf-galb-caption-icon">
                    <SofaGlyph />
                  </span>
                  <span className="ngf-galb-caption-text">
                    <span className="ngf-galb-caption-title">{tile.title}</span>
                    <span className="ngf-galb-caption-sub">{tile.subtitle}</span>
                  </span>
                </span>

                <button
                  type="button"
                  className="ngf-galb-expand"
                  aria-label={`Zoom ${tile.title} of ${tile.productName}`}
                  onClick={(event) => openZoom(index, event.currentTarget)}
                >
                  <ExpandGlyph />
                </button>

                {/* The stretched link — last so it does not precede the tile's own controls. */}
                <a
                  className="ngf-galb-link"
                  href={tile.href}
                  aria-label={`View ${tile.productName} — ${tile.title}`}
                >
                  <span className="sr-only">
                    {tile.productName} — {tile.title}
                  </span>
                </a>
              </article>
            </li>
          ))}
        </ul>
      )}

      {/* "See it in your space" — the conversion card the reference carries under the grid. */}
      <div className="ngf-galb-cta" data-reveal>
        <div className="ngf-galb-cta-copy">
          <h2 className="ngf-galb-cta-title">See it in your space</h2>
          <p className="ngf-galb-cta-body">
            Love what you see? Visit our showroom or get in touch for more photos, fabric options,
            and customisations.
          </p>
          <div className="ngf-galb-cta-actions">
            {whatsappHref !== null && (
              <a
                className="ngf-galb-cta-primary"
                href={whatsappHref}
                target="_blank"
                rel="noopener"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.46 1.32 4.97L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2Zm5.8 14.03c-.24.68-1.4 1.3-1.94 1.35-.54.06-1.04.08-1.6-.1a13.4 13.4 0 0 1-4.2-2.4 11.3 11.3 0 0 1-2.3-3.1c-.24-.5-.32-.94-.32-1.34 0-.6.3-1.1.72-1.53.16-.16.34-.2.48-.2h.34c.16 0 .32 0 .46.32.16.38.6 1.46.66 1.56.06.1.1.22.02.38-.08.16-.14.26-.26.4l-.2.24c-.1.12-.2.24-.1.44.1.2.48.82 1.02 1.32.7.66 1.28.86 1.48.96.2.1.32.08.44-.04.12-.14.5-.58.64-.78.14-.2.28-.16.46-.1.18.06 1.16.56 1.36.66.2.1.34.14.38.22.04.1.04.52-.14 1.06Z" />
                </svg>
                Enquire on WhatsApp
                <span aria-hidden="true">→</span>
              </a>
            )}
            <a className="ngf-galb-cta-secondary" href={productHref}>
              View Product
              <span aria-hidden="true">→</span>
            </a>
          </div>
        </div>
        <span className="ngf-galb-cta-script" aria-hidden="true">
          Same Comfort
          <br />
          Different Angles
        </span>
      </div>

      {zoomed !== null && zoomed !== undefined && (
        <Suspense
          fallback={<div className="ngf-gallery-zoom" data-surface="dark" role="presentation" />}
        >
          <GalleryZoom
            src={zoomed.zoomSrc}
            srcSet={zoomed.zoomSrcSet}
            alt={zoomed.alt}
            width={zoomed.width}
            height={zoomed.height}
            label={`${zoomed.title} — ${zoomed.productName}`}
            onClose={closeZoom}
          />
        </Suspense>
      )}
    </section>
  );
}
