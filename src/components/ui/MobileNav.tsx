/**
 * The mobile navigation panel (below 1024 px).
 *
 * The island owns exactly one thing — the open/closed state of a full-height panel — and
 * everything Requirements 9.5 and 9.6 demand of it:
 *
 * - **Full-height panel.** `position: fixed; inset: 0`, not a dropdown, so the whole viewport
 *   is the menu and nothing behind it competes for a tap.
 * - **Focus confined to the panel** while it is open, via the shared trap.
 * - **Escape closes and returns focus to the opener.** The opener is captured on open rather
 *   than assumed to be the toggle button, because the panel can also be opened from the
 *   sticky bar later.
 * - **Body scroll locked**, so a swipe on the panel cannot scroll the page underneath.
 *
 * The links themselves are passed in as data from `src/lib/site/navigation.ts` rather than
 * duplicated here, so the panel and the desktop header can never list different destinations.
 *
 * Requirements: 9.4, 9.5, 9.6, 24.3, 24.5, 24.7.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useScopedId } from '@/lib/ui/ids';

import { activateTrap } from '@/lib/ui/focus-trap';

export interface MobileNavLink {
  label: string;
  href: string;
}

export interface MobileNavProps {
  /** Every category route, in footer order. */
  categories: readonly MobileNavLink[];
  /** Collection, Custom Furniture, Contact, and the supporting pages. */
  pages: readonly MobileNavLink[];
}

/**
 * The category slug embedded in a `/collection/<slug>` href, or `null` for a non-category row.
 * Used to resolve the photographic thumbnail each category row shows in the reference.
 */
function categorySlug(href: string): string | null {
  const match = /^\/collection\/([a-z0-9-]+)$/.exec(href);
  return match?.[1] ?? null;
}

/**
 * The photographic thumbnail a category row shows — a small product cutout on the espresso ground,
 * matching the reference. One file per category lives at `/categories/<slug>/menu.webp`; the row
 * degrades to the espresso ground if a file is missing, so a new category never breaks the layout.
 */
function CategoryThumb({ slug }: { slug: string }): React.JSX.Element {
  return (
    <span
      className="ngf-mobilenav-thumb"
      style={{ backgroundImage: `url(/categories/${slug}/menu.webp)` }}
      aria-hidden="true"
    />
  );
}

/**
 * A hairline line-icon per menu row, keyed by the row's `href`. Every glyph is decorative — the
 * label carries the meaning — so each `<svg>` is `aria-hidden`. Drawn inline (no request) in the
 * warm champagne stroke the reference uses. An unmatched href falls back to a neutral dot, so a new
 * category never renders without an icon.
 */
function RowIcon({ href }: { href: string }): React.JSX.Element {
  const common = {
    viewBox: '0 0 24 24',
    width: 22,
    height: 22,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };
  switch (href) {
    case '/collection/sofas':
    case '/collection/accent-chairs':
      return (
        <svg {...common}>
          <path d="M4 11V8.5A2.5 2.5 0 0 1 6.5 6h11A2.5 2.5 0 0 1 20 8.5V11" />
          <path d="M3 11a2 2 0 0 1 2 2v3h14v-3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v4H1v-4a2 2 0 0 1 2-2Z" />
          <path d="M6 18v1.5M18 18v1.5" />
        </svg>
      );
    case '/collection/beds':
      return (
        <svg {...common}>
          <path d="M3 17V8a1 1 0 0 1 1-1h11a3 3 0 0 1 3 3v2h2a2 2 0 0 1 2 2v3" />
          <path d="M3 13h18M3 17v2M21 15v4" />
          <path d="M7 10h5v2H7z" />
        </svg>
      );
    case '/collection/dining-tables':
      return (
        <svg {...common}>
          <path d="M2 8h20M4 8v11M20 8v11M8 8v4M16 8v4" />
        </svg>
      );
    case '/collection/dining-chairs':
      return (
        <svg {...common}>
          <path d="M7 3v9h10V3M7 12l-1 8M17 12l1 8M6 16h12" />
        </svg>
      );
    case '/collection/coffee-side-tables':
      return (
        <svg {...common}>
          <ellipse cx="12" cy="7" rx="7" ry="2.5" />
          <path d="M12 9.5V20M8 20h8" />
        </svg>
      );
    case '/collection/storage-display':
      return (
        <svg {...common}>
          <path d="M4 4h7v16H4zM13 4h7v16h-7z" />
          <path d="M4 9h7M13 9h7M7 6v1M17 6v1" />
        </svg>
      );
    case '/collection/office':
      return (
        <svg {...common}>
          <circle cx="12" cy="6" r="2.5" />
          <path d="M8 12a4 4 0 0 1 8 0M12 12v5M8 20l4-3 4 3M12 8.5v3.5" />
        </svg>
      );
    case '/collection/outdoor':
      return (
        <svg {...common}>
          <path d="M12 3c5 0 9 4 9 8H3c0-4 4-8 9-8ZM12 3v-1M12 11v9M9 20h6" />
        </svg>
      );
    case '/collection/shoe-stands':
      return (
        <svg {...common}>
          <path d="M4 5h16v14H4zM4 10h16M4 15h16" />
          <path d="M7 7.5h4M7 12.5h4M7 17h4" />
        </svg>
      );
    case '/collection/temples':
      return (
        <svg {...common}>
          <path d="M12 3 21 8H3ZM5 8v8M9 8v8M15 8v8M19 8v8M3 20h18M4 16h16" />
        </svg>
      );
    case '/collection':
      return (
        <svg {...common}>
          <path d="m12 3 9 5-9 5-9-5 9-5ZM3 13l9 5 9-5M3 17l9 5 9-5" />
        </svg>
      );
    case '/about':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8h.01" />
        </svg>
      );
    case '/workshop':
      return (
        <svg {...common}>
          <path d="M14.5 5.5a3.6 3.6 0 0 0-3.9 4.7l-6.2 6.2a1.4 1.4 0 0 0 2 2l6.2-6.2a3.6 3.6 0 0 0 4.7-3.9l-2.3 2.3-2.1-.6-.6-2.1z" />
          <path d="m5 5 4 4M4 6l2-2" />
        </svg>
      );
    case '/gallery':
      return (
        <svg {...common}>
          <path d="M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6" />
          <circle cx="8.5" cy="9" r="1.5" />
        </svg>
      );
    case '/reviews':
      return (
        <svg {...common}>
          <path d="M12 4l2.3 4.7 5.2.8-3.8 3.7.9 5.2L12 16.1 7.4 18.4l.9-5.2L4.5 9.5l5.2-.8z" />
        </svg>
      );
    case '/custom-furniture':
      return (
        <svg {...common}>
          <path d="M3 12h6l1.5-3 3 6L15 12h6M4 16h16M6 20h12" />
        </svg>
      );
    case '/contact':
      return (
        <svg {...common}>
          <path d="M4 5h16v14H4zM4 6l8 6 8-6" />
        </svg>
      );
    case '/faq':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .8-1 1.7M12 16.5h.01" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="2" />
        </svg>
      );
  }
}

function Chevron(): React.JSX.Element {
  return (
    <svg
      className="ngf-mobilenav-chevron"
      viewBox="0 0 8 14"
      width={8}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M1 1l6 6-6 6" />
    </svg>
  );
}

export default function MobileNav({
  categories,
  pages,
}: MobileNavProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const panelId = useScopedId('ngf-mobilenav-panel');
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    // Requirement 9.6: focus returns to whatever opened the panel.
    openerRef.current?.focus();
  }, []);

  const toggle = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    openerRef.current = event.currentTarget;
    setOpen((previous) => !previous);
  }, []);

  useEffect(() => {
    const panel = panelRef.current;
    if (!open || panel === null) return;
    // While the panel owns the viewport, mark the document so the sticky action bar and page
    // scroll stand down — the reference menu is the only thing on screen.
    document.body.dataset.mobilenavOpen = 'true';
    const teardownTrap = activateTrap(panel, { onEscape: close });
    return () => {
      teardownTrap();
      delete document.body.dataset.mobilenavOpen;
    };
  }, [open, close]);

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="ngf-mobilenav-toggle"
      >
        <span className="ngf-mobilenav-bars" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="sr-only">{open ? 'Close menu' : 'Menu'}</span>
      </button>

      <div
        id={panelId}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Site menu"
        hidden={!open}
        className="ngf-mobilenav-panel"
        data-surface="dark"
      >
        <div className="ngf-mobilenav-head">
          <p className="ngf-mobilenav-eyebrow">Menu</p>
          <button
            type="button"
            onClick={close}
            className="ngf-mobilenav-close"
            aria-label="Close menu"
          >
            <svg
              viewBox="0 0 24 24"
              width={22}
              height={22}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M5 5l14 14M19 5 5 19" />
            </svg>
          </button>
        </div>

        {/*
          The showroom photograph bleeds in from the right edge, behind the menu column — the
          reference's warm arch, plant and armchair. Decorative (the labels carry all meaning), so
          `aria-hidden`; a plain same-origin WebP, lazy since the panel only mounts when opened.
        */}
        <div className="ngf-mobilenav-scene" aria-hidden="true">
          <img
            className="ngf-mobilenav-scene-photo"
            src="/brand/menu-scene.webp"
            width={640}
            height={2027}
            alt=""
            loading="lazy"
            decoding="async"
          />
        </div>

        <nav aria-label="Categories" className="ngf-mobilenav-section">
          <h2 className="ngf-mobilenav-heading">
            <span>Shop by category</span>
          </h2>
          <ul className="ngf-mobilenav-list">
            {categories.map((link) => {
              const slug = categorySlug(link.href);
              return (
                <li key={link.href}>
                  <a href={link.href} onClick={close}>
                    <span className="ngf-mobilenav-icon">
                      {slug ? (
                        <CategoryThumb slug={slug} />
                      ) : (
                        <RowIcon href={link.href} />
                      )}
                    </span>
                    <span className="ngf-mobilenav-label">{link.label}</span>
                    <Chevron />
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        <nav aria-label="Pages" className="ngf-mobilenav-section">
          <h2 className="ngf-mobilenav-heading">
            <span>More</span>
          </h2>
          <ul className="ngf-mobilenav-list ngf-mobilenav-list-more">
            {pages.map((link) => (
              <li key={`${link.href}-${link.label}`}>
                <a href={link.href} onClick={close}>
                  <span className="ngf-mobilenav-icon ngf-mobilenav-icon-line">
                    <RowIcon href={link.href} />
                  </span>
                  <span className="ngf-mobilenav-label">{link.label}</span>
                  <Chevron />
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </>
  );
}
