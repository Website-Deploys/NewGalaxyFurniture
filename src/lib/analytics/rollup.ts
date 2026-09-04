/**
 * The event write path: validate a batch, then fold it into daily aggregates.
 *
 * The public `POST /api/events` endpoint is task 18's. What lives here is the part the admin
 * side depends on and the part worth testing on its own: the validation rules and the upsert.
 *
 * The shape of this module is the privacy guarantee. `recordEvents` takes a batch and a day
 * string and writes counters; there is no parameter for a visitor identifier, no parameter for
 * an address, and no table to put one in (see `migrations/0003_events.sql`). Requirement 20.2
 * is therefore satisfied by the absence of a code path rather than by a policy about how to use
 * one.
 *
 * Two details that matter under load:
 *
 * - **The batch is folded before it is written.** Ten `product_view` events for one product in
 *   one batch become one `+10`, not ten statements. That is what keeps a flush inside D1's
 *   statement budget.
 * - **The upsert adds rather than replaces.** `count = count + excluded.count` means two
 *   Workers flushing concurrently cannot lose a count, which a read-modify-write would.
 *
 * Design: Conversion → Analytics.
 * Requirements: 20.1, 20.2, 20.3, 20.11.
 */

import type { D1Database } from '@cloudflare/workers-types';

export const ANALYTICS_EVENT_TYPES = [
  'product_view',
  'category_view',
  'whatsapp_click',
  'call_click',
  'search',
  'enquiry_submit',
  'quick_enquire_open',
  'gallery_open',
] as const;

export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];

export interface AnalyticsEvent {
  t: AnalyticsEventType;
  /** Entity: product slug, category slug, or the normalised query for a search. */
  e?: string;
  ts: number;
  /** Result count for a `search`. Absent for every other type. */
  r?: number;
}

/** The design's batch limits (Requirement 20.3). */
export const MAX_BATCH_EVENTS = 20;
export const MAX_ENTITY_LENGTH = 120;
export const MAX_TIMESTAMP_SKEW_MS = 10 * 60_000;

function isEventType(value: unknown): value is AnalyticsEventType {
  return typeof value === 'string' && (ANALYTICS_EVENT_TYPES as readonly string[]).includes(value);
}

/** `YYYY-MM-DD` in UTC from an epoch-ms instant. */
export function dayOf(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** Trimmed, lowercased, collapsed whitespace — so `"Sofa "` and `"sofa"` are one query. */
export function normalizeQuery(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, MAX_ENTITY_LENGTH);
}

export interface ValidatedBatch {
  events: AnalyticsEvent[];
  /** How many submitted entries were dropped, and why — logged, never returned verbatim. */
  rejected: number;
}

/**
 * Validate a submitted batch.
 *
 * Invalid *entries* are dropped rather than failing the whole batch: a beacon is fire-and-forget
 * and the client cannot retry usefully, so discarding one malformed entry and keeping nine good
 * ones loses less truth than discarding all ten. An over-long batch is truncated for the same
 * reason. `rejected` is returned so the drop rate is observable rather than invisible.
 */
export function validateBatch(raw: unknown, now: number = Date.now()): ValidatedBatch {
  if (!Array.isArray(raw)) return { events: [], rejected: 0 };

  const events: AnalyticsEvent[] = [];
  let rejected = 0;

  for (const candidate of raw.slice(0, MAX_BATCH_EVENTS)) {
    if (typeof candidate !== 'object' || candidate === null) {
      rejected += 1;
      continue;
    }
    const entry = candidate as Record<string, unknown>;
    if (!isEventType(entry.t) || typeof entry.ts !== 'number' || !Number.isFinite(entry.ts)) {
      rejected += 1;
      continue;
    }
    if (Math.abs(now - entry.ts) > MAX_TIMESTAMP_SKEW_MS) {
      rejected += 1;
      continue;
    }

    const rawEntity = typeof entry.e === 'string' ? entry.e : '';
    const entity =
      entry.t === 'search' ? normalizeQuery(rawEntity) : rawEntity.slice(0, MAX_ENTITY_LENGTH);
    // A search with no query text is not a measurement of anything.
    if (entry.t === 'search' && entity === '') {
      rejected += 1;
      continue;
    }

    const event: AnalyticsEvent = { t: entry.t, ts: entry.ts, e: entity };
    if (
      entry.t === 'search' &&
      typeof entry.r === 'number' &&
      Number.isFinite(entry.r) &&
      entry.r >= 0
    ) {
      event.r = Math.floor(entry.r);
    }
    events.push(event);
  }

  rejected += Math.max(0, (Array.isArray(raw) ? raw.length : 0) - MAX_BATCH_EVENTS);
  return { events, rejected };
}

interface Tally {
  day: string;
  type: AnalyticsEventType;
  entity: string;
  count: number;
}

interface QueryTally {
  day: string;
  query: string;
  count: number;
  results: number | null;
}

/** Fold a validated batch into one row per (day, type, entity). */
export function foldBatch(events: readonly AnalyticsEvent[]): {
  tallies: Tally[];
  queries: QueryTally[];
} {
  const tallies = new Map<string, Tally>();
  const queries = new Map<string, QueryTally>();

  for (const event of events) {
    // The day comes from the event's own timestamp, which validation has already constrained
    // to within ten minutes of the server clock — so a batch flushed across midnight lands on
    // the correct side of it.
    const day = dayOf(event.ts);
    const entity = event.e ?? '';

    const key = `${day}\u0000${event.t}\u0000${entity}`;
    const existing = tallies.get(key);
    if (existing === undefined) tallies.set(key, { day, type: event.t, entity, count: 1 });
    else existing.count += 1;

    if (event.t === 'search') {
      const queryKey = `${day}\u0000${entity}`;
      const seen = queries.get(queryKey);
      if (seen === undefined) {
        queries.set(queryKey, {
          day,
          query: entity,
          count: 1,
          results: event.r ?? null,
        });
      } else {
        seen.count += 1;
        // The most recent reported result count wins; an absent one does not erase a known one.
        if (event.r !== undefined) seen.results = event.r;
      }
    }
  }

  return { tallies: [...tallies.values()], queries: [...queries.values()] };
}

/**
 * Write a validated batch as aggregate increments.
 *
 * Returns how many counter rows were touched, which is what an endpoint can honestly report:
 * not "your events were recorded" but "this many counters moved".
 */
export async function recordEvents(
  db: D1Database,
  events: readonly AnalyticsEvent[],
): Promise<{ tallies: number; queries: number }> {
  const { tallies, queries } = foldBatch(events);
  if (tallies.length === 0 && queries.length === 0) return { tallies: 0, queries: 0 };

  const statements = [
    ...tallies.map((tally) =>
      db
        .prepare(
          'INSERT INTO event_daily (day, type, entity, count) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT (day, type, entity) DO UPDATE SET count = count + excluded.count',
        )
        .bind(tally.day, tally.type, tally.entity, tally.count),
    ),
    ...queries.map((query) =>
      db
        .prepare(
          'INSERT INTO search_queries (day, query, count, results) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT (day, query) DO UPDATE SET count = count + excluded.count, ' +
            // COALESCE keeps a known result count when this batch reported none.
            'results = COALESCE(excluded.results, search_queries.results)',
        )
        .bind(query.day, query.query, query.count, query.results),
    ),
  ];

  await db.batch(statements);
  return { tallies: tallies.length, queries: queries.length };
}
