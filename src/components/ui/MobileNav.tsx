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

import { useCallback, useEffect, useId, useRef, useState } from 'react';

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
  /** Pre-built, from `buildWhatsAppUrl` on the server. Never assembled here. */
  whatsappHref: string;
  telHref: string;
  /** `+91 95134 43606` — display only. */
  telDisplay: string;
  /** The one shared label both numbers carry. */
  numberLabel: string;
}

export default function MobileNav({
  categories,
  pages,
  whatsappHref,
  telHref,
  telDisplay,
  numberLabel,
}: MobileNavProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const panelId = useId();
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
    return activateTrap(panel, { onEscape: close });
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
          <button type="button" onClick={close} className="ngf-mobilenav-close">
            <span aria-hidden="true">×</span>
            <span className="sr-only">Close menu</span>
          </button>
        </div>

        <nav aria-label="Categories" className="ngf-mobilenav-section">
          <h2 className="ngf-mobilenav-heading">Shop by category</h2>
          <ul className="ngf-mobilenav-list">
            {categories.map((link) => (
              <li key={link.href}>
                <a href={link.href} onClick={close}>
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <nav aria-label="Pages" className="ngf-mobilenav-section">
          <h2 className="ngf-mobilenav-heading">More</h2>
          <ul className="ngf-mobilenav-list">
            {pages.map((link) => (
              <li key={`${link.href}-${link.label}`}>
                <a href={link.href} onClick={close}>
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/*
          Real links, with their destinations in `href`, so long-press and copy-link work
          from inside the panel exactly as they do elsewhere (Requirement 5.11). Both
          controls carry the same label — neither number is a different department (5.10).
        */}
        <div className="ngf-mobilenav-cta">
          <p className="ngf-mobilenav-eyebrow">{numberLabel}</p>
          <a href={whatsappHref} target="_blank" rel="noopener" className="ngf-mobilenav-primary">
            Order or Enquire on WhatsApp
          </a>
          <a href={telHref} className="ngf-mobilenav-secondary">
            Call {telDisplay}
          </a>
        </div>
      </div>
    </>
  );
}
