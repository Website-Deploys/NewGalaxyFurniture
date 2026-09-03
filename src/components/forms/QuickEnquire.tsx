/**
 * Quick Enquire: the product form, and the page-level host that opens it.
 *
 * **Why one host rather than one island per card.** A catalogue page renders up to sixty
 * product cards. Hydrating a form island inside each one would ship sixty React trees to
 * satisfy a control that at most one visitor in ten ever presses, and would blow the JS budget
 * on its own. So the card keeps its existing markup and this component — a single island,
 * mounted once per page — listens for a click on any `[data-ngf-quick-enquire]` element,
 * reads the product from its data attributes, and opens one dialog.
 *
 * **Why the card's control stays an `<a href>` to WhatsApp.** It is a progressive enhancement,
 * and the fallback matters: with this island unhydrated, or JavaScript unavailable, or an error
 * in a different island on the page, the control still reaches a human on WhatsApp. Once the
 * host is listening it calls `preventDefault()`, so activating it opens the form and does not
 * navigate — which is Requirement 1.10's actual demand (scroll position, applied filters and
 * search text all survive because nothing navigates and nothing re-renders the listing).
 *
 * The dialog is a `role="dialog"` with `aria-modal`, focus trapped by the shared trap, Escape
 * to close, and focus restored to the control that opened it. It emits `quick_enquire_open`
 * exactly once per opening, from here rather than from the card, so the count is of openings
 * and not of clicks that were prevented.
 *
 * Requirements: 1.10, 6.1, 6.3, 20.1, 24.8, 24.9.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import EnquiryForm, { type FallbackNumber } from './EnquiryForm';
import { activateTrap } from '@/lib/ui/focus-trap';
import { current as currentBatcher } from '@/lib/analytics/client';

/** The attribute the card and the PDP mark their Quick Enquire control with. */
export const QUICK_ENQUIRE_ATTR = 'data-ngf-quick-enquire';

export interface QuickEnquireProps {
  numbers: readonly FallbackNumber[];
}

interface OpenFor {
  slug: string;
  name: string;
  /** The control that opened the dialog, so focus can be handed back to it. */
  opener: HTMLElement | null;
}

/** The form itself, without the dialog — usable inline on a PDP if a page prefers that. */
export function QuickEnquireForm(props: {
  productSlug: string;
  productName: string;
  numbers: readonly FallbackNumber[];
  onSuccess?: () => void;
}): ReactElement {
  return (
    <EnquiryForm
      type="QUICK_ENQUIRE"
      fields={['name', 'phone', 'message']}
      submitLabel="Send enquiry"
      intro="Ask about price, availability, timber or delivery. We reply on WhatsApp or by phone."
      productSlug={props.productSlug}
      productName={props.productName}
      numbers={props.numbers}
      {...(props.onSuccess === undefined ? {} : { onSuccess: props.onSuccess })}
    />
  );
}

export default function QuickEnquire(props: QuickEnquireProps): ReactElement | null {
  const [open, setOpen] = useState<OpenFor | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => {
    setOpen((current) => {
      // Focus goes back to whatever opened the dialog. Losing it to `<body>` would drop a
      // keyboard user at the top of the page, having lost their place in the listing.
      current?.opener?.focus();
      return null;
    });
  }, []);

  /* --- The delegated listener. One per page, added once. -------------------- */
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      // Modified clicks are the visitor asking for the link's real destination. Let them have
      // it: this is why the control is a link and not a button.
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (event.button !== 0) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const control = target.closest(`[${QUICK_ENQUIRE_ATTR}]`);
      if (!(control instanceof HTMLElement)) return;

      const slug = control.dataset.ngfProductSlug ?? '';
      const name = control.dataset.ngfProductName ?? '';
      if (slug === '') return;

      event.preventDefault();
      setOpen({ slug, name, opener: control });
      currentBatcher()?.track('quick_enquire_open', slug);
    };

    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  /* --- Trap, scroll lock and Escape, only while open. ----------------------- */
  useEffect(() => {
    if (open === null) return;
    const panel = panelRef.current;
    if (panel === null) return;
    return activateTrap(panel, { onEscape: close });
  }, [open, close]);

  if (open === null) return null;

  return (
    <div className="ngf-quick-overlay" data-ngf-quick-enquire-dialog>
      {/*
        The backdrop is a button, not a div with a click handler: it is a real control that
        closes the dialog, so it is reachable and announced rather than being an invisible
        click target only a mouse can find.
      */}
      <button type="button" className="ngf-quick-backdrop" onClick={close}>
        <span className="ngf-sr-only">Close this enquiry</span>
      </button>

      <div
        className="ngf-quick-panel"
        role="dialog"
        aria-modal="true"
        aria-label={open.name === '' ? 'Quick enquiry' : `Quick enquiry — ${open.name}`}
        ref={panelRef}
      >
        <div className="ngf-quick-head">
          <h2 className="ngf-quick-title">Quick enquire</h2>
          <button type="button" className="ngf-quick-close" onClick={close}>
            Close
          </button>
        </div>
        <QuickEnquireForm productSlug={open.slug} productName={open.name} numbers={props.numbers} />
      </div>
    </div>
  );
}
