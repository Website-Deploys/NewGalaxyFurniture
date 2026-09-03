/**
 * Wiring the page's events to the batcher.
 *
 * Two mechanisms, chosen per event by what is actually observable:
 *
 * - **The page's own view event comes from a `<meta>` tag** the layout emits. A product page
 *   knows it is a product page and knows the slug; asking the browser to infer that from the URL
 *   would be a second, weaker copy of the routing table.
 * - **Click events are delegated from `document`.** Two listeners for the whole page, not one per
 *   link, and they work for links added after boot — which matters because `MobileActionBar`,
 *   `RecentlyViewed` and the Quick Enquire dialog all render their controls after hydration. The
 *   markers they hang off (`data-ngf-whatsapp`, `data-ngf-call`) already existed on the shared
 *   link components before this module did; nothing new had to be marked.
 *
 * The remaining four events — `search`, `gallery_open`, `quick_enquire_open` and `enquiry_submit`
 * — are reported by the islands that own them, because each is a *decision* the island makes and
 * not a click that can be observed from outside it. A search is reported when it is committed,
 * not when a key is pressed; the gallery reports opening zoom, not clicking the button that was
 * disabled.
 *
 * Nothing here reads or writes storage, sets a cookie, or derives an identifier. There is
 * nothing to opt out of because there is nothing being collected about a person.
 *
 * Design: Conversion → Analytics.
 * Requirements: 20.1, 20.2.
 */

import { install, type AnalyticsEventType } from './client';
import { ANALYTICS_EVENT_TYPES } from './rollup';

/** The meta tag the layout emits: `content="product_view:rolled-arm-sofa"`. */
export const PAGE_EVENT_META = 'ngf:page-event';

/** The meta tag naming the page's subject, so a click can be attributed to it. */
export const PAGE_ENTITY_META = 'ngf:page-entity';

function metaContent(name: string): string | null {
  const element = document.querySelector(`meta[name="${name}"]`);
  if (!(element instanceof HTMLMetaElement)) return null;
  const value = element.content.trim();
  return value === '' ? null : value;
}

/** Split `type:entity` into its parts, accepting a colon inside the entity. */
export function parsePageEvent(value: string): { type: AnalyticsEventType; entity: string } | null {
  const separator = value.indexOf(':');
  const type = separator === -1 ? value : value.slice(0, separator);
  const entity = separator === -1 ? '' : value.slice(separator + 1);
  if (!(ANALYTICS_EVENT_TYPES as readonly string[]).includes(type)) return null;
  return { type: type as AnalyticsEventType, entity };
}

/**
 * Install the batcher, report the page view, and start listening for conversions.
 *
 * Idempotent through `install()`, so a second call on a page cannot double-count.
 */
export function bootAnalytics(): void {
  const batcher = install();

  const declared = metaContent(PAGE_EVENT_META);
  if (declared !== null) {
    const parsed = parsePageEvent(declared);
    if (parsed !== null) batcher.track(parsed.type, parsed.entity);
  }

  // What a click on this page is *about*: the product or category it is showing. Absent on a
  // static page, where a WhatsApp click has no subject and is counted with an empty entity.
  const entity = metaContent(PAGE_ENTITY_META) ?? '';

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[data-ngf-whatsapp]') !== null) {
        batcher.track('whatsapp_click', entity);
        return;
      }
      if (target.closest('[data-ngf-call]') !== null) {
        batcher.track('call_click', entity);
      }
    },
    // Passive and non-capturing: this must never be able to delay or alter a navigation. A
    // `tel:` link that failed to open because an analytics listener threw would be a real
    // lost sale.
    { passive: true },
  );
}
