/**
 * The recently-viewed section.
 *
 * `client:idle`, and it renders nothing on the server on purpose: the list exists only on the
 * visitor's device (Requirement 4.10), so there is nothing the server could render that would not
 * be a guess. The section appears after hydration or not at all, which is also why it sits low on
 * the page — nothing above it moves when it arrives.
 *
 * Two states, and only two:
 *
 * - **Omitted entirely** when the buffer holds fewer than two products other than the current one,
 *   or when the device retains no list at all (Requirement 4.11). Not a heading with one card
 *   under it, and not an empty state — the visitor has not asked for anything here.
 * - **Rendered**, most recent first, current product excluded.
 *
 * Every decision above is `visibleRecent`'s, not this component's. The component records the view,
 * reads the list, and paints it.
 *
 * Requirements: 4.10, 4.11.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  clearRecent,
  recordView,
  visibleRecent,
  type RecentCard,
  type RecentEntry,
} from '@/lib/products/recently-viewed';

export interface RecentlyViewedProps {
  /** The product being viewed. Recorded on mount, and excluded from the rendering. */
  slug: string;
  /** The current product's own summary, so the buffer can describe it on a later visit. */
  card: RecentCard;
  heading?: string;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export default function RecentlyViewed({
  slug,
  card,
  heading = 'Recently viewed',
}: RecentlyViewedProps): React.JSX.Element | null {
  const [entries, setEntries] = useState<RecentEntry[]>([]);

  useEffect(() => {
    // The write happens on view (Requirement 4.10) and the read is the same call's return value,
    // so the rendered list can never disagree with what was just stored.
    setEntries(recordView(storage(), { slug, ts: Date.now(), card }));
  }, [slug, card]);

  const onClear = useCallback(() => {
    setEntries(clearRecent(storage()));
  }, []);

  const shown = visibleRecent(entries, slug);
  if (shown.length === 0) return null;

  return (
    <section className="ngf-pdp-section" aria-labelledby="ngf-recent-heading" data-ngf-recent>
      <div className="ngf-recent-head">
        <h2 id="ngf-recent-heading">{heading}</h2>
        <button type="button" onClick={onClear} className="ngf-recent-clear">
          Clear
        </button>
      </div>
      <ul className="ngf-recent-list">
        {shown.map((entry) => (
          <li key={entry.slug}>
            <a href={entry.card.href} className="ngf-recent-card">
              <span
                className="ngf-recent-media"
                style={
                  entry.card.lqip === undefined
                    ? undefined
                    : { backgroundImage: `url(${entry.card.lqip})` }
                }
              >
                {entry.card.thumb === undefined ? null : (
                  <img
                    src={entry.card.thumb}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    width={320}
                    height={240}
                  />
                )}
              </span>
              <span className="ngf-recent-name">{entry.card.name}</span>
              <span className="ngf-recent-price">{entry.card.price}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
