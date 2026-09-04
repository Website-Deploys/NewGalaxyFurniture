/**
 * The recently-viewed ring buffer.
 *
 * Requirement 4.10 is as much a privacy statement as a feature: the list lives "on the visitor's
 * own device, with no account and no server-side visitor record". So this module touches
 * `localStorage` and nothing else — no cookie (a cookie is sent to the origin on every request,
 * which *is* a server-side record), no fetch, no identifier of any kind. The stored value is a list
 * of products the visitor already asked for by navigating to them.
 *
 * The buffer's three rules, all from 4.10:
 *
 * - at most eight entries;
 * - viewing a product **moves** its existing entry to the most recent position rather than adding
 *   a second one;
 * - the oldest entry is discarded once the list would exceed eight.
 *
 * Those live in `pushRecent`, which is pure — a list in, a list out — so the ordering and eviction
 * rules are tested directly rather than through a storage double.
 *
 * **Why each entry carries a card and not just a slug.** The design sketches the entry as
 * `{slug, ts}`, which is the minimum needed to *record* a view. It is not enough to *render* one:
 * the section shows product cards, and the slugs are only known in the browser, so a slug-only
 * buffer forces the page to ship a name, price, and thumbnail for every product in the catalogue
 * on the chance that the visitor saw one — a payload that grows with the catalogue and is wasted
 * on almost every visitor. Instead each entry carries the summary of the product it names,
 * captured from the page that already rendered it. The buffer stays device-local and bounded at
 * eight, the PDP ships nothing extra, and there is no lookup table to keep in step. The cost is
 * that a renamed product shows its old name until it is viewed again, which is the cheaper of the
 * two errors.
 *
 * Requirements: 4.10, 4.11.
 */

/** The one storage key. Namespaced like the motion preference and the recent searches. */
export const RECENTLY_VIEWED_KEY = 'ngf:recently-viewed';

/** Requirement 4.10's ceiling. */
export const RECENTLY_VIEWED_MAX = 8;

/** Requirement 4.11: below two *other* products the section is omitted entirely. */
export const RECENTLY_VIEWED_MIN_VISIBLE = 2;

/** Everything the compact card needs, and nothing else. */
export interface RecentCard {
  name: string;
  /** Already formatted by `formatPriceOrLabel` on the server — never an amount to format here. */
  price: string;
  href: string;
  thumb?: string;
  lqip?: string;
  alt?: string;
}

export interface RecentEntry {
  slug: string;
  /** Epoch milliseconds, from the visitor's own clock. Used only for ordering. */
  ts: number;
  /** Absent only for an entry written by an older version, or hand-edited storage. */
  card?: RecentCard;
}

/**
 * Insert or move `slug` to the most recent position.
 *
 * Most recent **first**, which is also the render order (4.11), so no surface has to reverse the
 * list and none can reverse it by accident.
 */
export function pushRecent(
  entries: readonly RecentEntry[],
  entry: RecentEntry,
  max: number = RECENTLY_VIEWED_MAX,
): RecentEntry[] {
  const slug = entry.slug.trim();
  if (slug === '') return [...entries];
  // Filtering the slug out first is what makes a repeat view a *move*: there is never a moment at
  // which two entries name the same product.
  const withoutSlug = entries.filter((existing) => existing.slug !== slug);
  return [{ ...entry, slug }, ...withoutSlug].slice(0, Math.max(0, max));
}

/**
 * The products to render: most recent first, the current product excluded, and empty unless at
 * least two remain (Requirement 4.11).
 *
 * Returning `[]` rather than a short list is the whole rule — the section is omitted, not
 * shortened, because one card under a "Recently viewed" heading tells the visitor nothing they do
 * not already know.
 *
 * An entry with no card is not renderable and therefore does not count towards the two: a product
 * that cannot be described cannot be presented.
 */
export function visibleRecent(
  entries: readonly RecentEntry[],
  currentSlug: string,
  min: number = RECENTLY_VIEWED_MIN_VISIBLE,
): (RecentEntry & { card: RecentCard })[] {
  const others = entries.filter(
    (entry): entry is RecentEntry & { card: RecentCard } =>
      entry.slug !== currentSlug && entry.card !== undefined,
  );
  return others.length < min ? [] : others;
}

/* -------------------------------------------------------------------------- */
/* Storage                                                                    */
/* -------------------------------------------------------------------------- */

function parseCard(value: unknown): RecentCard | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { name, price, href, thumb, lqip, alt } = value as Record<string, unknown>;
  if (typeof name !== 'string' || typeof price !== 'string' || typeof href !== 'string') {
    return undefined;
  }
  // `href` is re-checked rather than trusted: it is injected straight into an anchor, and this
  // value came out of storage, which is visitor-writable. A site-relative product path only.
  if (!/^\/product\/[a-z0-9][a-z0-9-]*$/.test(href)) return undefined;
  return {
    name,
    price,
    href,
    ...(typeof thumb === 'string' ? { thumb } : {}),
    ...(typeof lqip === 'string' ? { lqip } : {}),
    ...(typeof alt === 'string' ? { alt } : {}),
  };
}

/**
 * Parse a stored value defensively.
 *
 * Anything unparseable, wrongly shaped, or hand-edited becomes the empty list rather than an
 * exception. This value is written by older versions of this code as often as by the current one,
 * and a visitor with a stale entry must not get a broken page — Requirement 4.11 already names
 * "the device retains no such list" as a valid state, so degrading to it is correct.
 */
export function parseRecent(raw: string | null): RecentEntry[] {
  if (raw === null || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: RecentEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of parsed) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const { slug, ts, card } = candidate as Record<string, unknown>;
    if (typeof slug !== 'string' || slug.trim() === '' || seen.has(slug)) continue;
    seen.add(slug);
    const parsedCard = parseCard(card);
    out.push({
      slug,
      ts: typeof ts === 'number' && Number.isFinite(ts) ? ts : 0,
      ...(parsedCard === undefined ? {} : { card: parsedCard }),
    });
    if (out.length >= RECENTLY_VIEWED_MAX) break;
  }
  return out;
}

export function serializeRecent(entries: readonly RecentEntry[]): string {
  return JSON.stringify(entries);
}

/**
 * A minimal storage surface, so the reader and writer can be exercised without a browser and so a
 * blocked `localStorage` is a supported state rather than a crash. Private-mode Safari and
 * cookie-blocking extensions both throw on access, not only on write.
 */
export interface RecentStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function readRecent(storage: RecentStorage | null): RecentEntry[] {
  if (storage === null) return [];
  try {
    return parseRecent(storage.getItem(RECENTLY_VIEWED_KEY));
  } catch {
    return [];
  }
}

export function writeRecent(storage: RecentStorage | null, entries: readonly RecentEntry[]): void {
  if (storage === null) return;
  try {
    storage.setItem(RECENTLY_VIEWED_KEY, serializeRecent(entries));
  } catch {
    /* storage unavailable or full — the list is a convenience, never a requirement */
  }
}

/**
 * Record a view and return the stored list.
 *
 * One function, so "write on PDP view" cannot be implemented differently on a future surface:
 * read, push, write, return.
 */
export function recordView(storage: RecentStorage | null, entry: RecentEntry): RecentEntry[] {
  const next = pushRecent(readRecent(storage), entry);
  writeRecent(storage, next);
  return next;
}

/** Forget the list — the "clear" control the design calls for. */
export function clearRecent(storage: RecentStorage | null): RecentEntry[] {
  writeRecent(storage, []);
  return [];
}
