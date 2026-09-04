/**
 * The nightly analytics snapshot: what it contains, and when it is worth committing.
 *
 * `data/snapshots/analytics.json` is the measured input behind the Most Viewed and Trending sorts.
 * Until it exists both fall back to the operator's curated ordering and say so — that is the
 * designed fallback, and this file is what turns "curated" into "measured as of a date".
 *
 * Everything here is pure. The D1 read, the GitHub write and the schedule live in
 * `snapshot-cron.ts`, so the shape of the artifact and the decision to commit are testable without a
 * Worker, a database, or a repository.
 *
 * Three decisions worth stating:
 *
 * 1. **`views` is lifetime, `velocity` is the last seven days.** That is what
 *    `AnalyticsSnapshot` in `@/lib/search/sort` documents them to be, and the two sorts read them
 *    differently: Most Viewed wants the total, Trending wants the recent rate. Both come from the
 *    *same* `measuredViewCounts` query over two ranges rather than from two new queries.
 * 2. **An empty table is omitted, not written as `{}`.** `getAnalyticsSnapshot` rejects a snapshot
 *    whose numbers are all absent, because a date beside an ordering that is really the curated one
 *    is a lie the UI would repeat. Omitting the key keeps that check meaningful.
 * 3. **An unchanged snapshot is not committed.** A commit per night whose diff is only `asOf` would
 *    fill the audit trail with noise and, worse, would make `git log data/snapshots/` useless for
 *    seeing when the numbers actually moved. Before launch — no events at all — this means the cron
 *    runs nightly and writes nothing.
 *
 * Design: Conversion → Analytics; Catalogue → Sorting, with honest fallbacks.
 * Requirements: 3.14, 3.15, 20.11.
 */

import type { AnalyticsRange } from './queries';
import type { AnalyticsSnapshot } from '@/lib/search/sort';

/** The one path this cron may write. It is on the `resolveContentPath` allowlist. */
export const SNAPSHOT_PATH = 'data/snapshots/analytics.json';

/** Trending's window, per `AnalyticsSnapshot.velocity`. */
export const VELOCITY_WINDOW_DAYS = 7;

/**
 * The lower bound of the "lifetime" range.
 *
 * A fixed date rather than an open bound: `event_daily.day` is a `YYYY-MM-DD` string and the query
 * compares it lexicographically, so a bound has to be a well-formed day. This one predates any
 * possible row — the site did not exist — so it is "everything ever recorded" without pretending to
 * be a special value.
 */
export const LIFETIME_FROM = '2025-01-01';

/** `YYYY-MM-DD` in UTC, which is the timezone `event_daily.day` is bucketed in. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface SnapshotRanges {
  /** Everything recorded, up to and including the last complete day. */
  lifetime: AnalyticsRange;
  /** The seven complete days ending with `lifetime.to`. */
  velocity: AnalyticsRange;
}

/**
 * The two ranges to measure, given the moment the cron fired.
 *
 * Both end **yesterday**, not today: today is a partial day, and including it would make every
 * snapshot's newest bucket an arbitrary fraction of a day's traffic — so a product's velocity would
 * depend on what time the cron happened to run.
 */
export function snapshotRanges(now: Date): SnapshotRanges {
  const end = new Date(now.getTime());
  end.setUTCDate(end.getUTCDate() - 1);
  const to = utcDay(end);

  const start = new Date(end.getTime());
  start.setUTCDate(start.getUTCDate() - (VELOCITY_WINDOW_DAYS - 1));

  return {
    lifetime: { from: LIFETIME_FROM, to },
    velocity: { from: utcDay(start), to },
  };
}

/** Drop zero and non-finite counts: a zero is the absence of a measurement, not a measurement. */
function meaningfulCounts(counts: Record<string, number>): Record<string, number> | undefined {
  const table: Record<string, number> = {};
  for (const [slug, count] of Object.entries(counts)) {
    if (slug !== '' && Number.isFinite(count) && count > 0) table[slug] = count;
  }
  return Object.keys(table).length === 0 ? undefined : table;
}

/**
 * The snapshot record, or `null` when there is nothing measured to report.
 *
 * `null` is the pre-launch state and it is not a failure: with no events recorded, the honest
 * artifact is no artifact, and both sorts stay labelled curated.
 */
export function buildAnalyticsSnapshot(input: {
  asOf: string;
  views: Record<string, number>;
  velocity: Record<string, number>;
}): AnalyticsSnapshot | null {
  const views = meaningfulCounts(input.views);
  const velocity = meaningfulCounts(input.velocity);
  if (views === undefined && velocity === undefined) return null;
  return {
    asOf: input.asOf,
    ...(views === undefined ? {} : { views }),
    ...(velocity === undefined ? {} : { velocity }),
  };
}

/** Stable JSON, two-space indented and newline-terminated, as every content file is written. */
export function serializeSnapshot(snapshot: AnalyticsSnapshot): string {
  const ordered: Record<string, unknown> = { asOf: snapshot.asOf };
  if (snapshot.views !== undefined) ordered.views = sortedTable(snapshot.views);
  if (snapshot.velocity !== undefined) ordered.velocity = sortedTable(snapshot.velocity);
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Key order is fixed by slug, so a night with identical numbers produces identical bytes.
 *
 * Without this, `Object.entries` order would follow whatever order D1 returned the rows in, and two
 * runs over the same data could differ textually — which would defeat the "do not commit an
 * unchanged snapshot" rule and put a meaningless diff in the audit trail.
 */
function sortedTable(table: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(table).sort()) out[key] = table[key] ?? 0;
  return out;
}

/** True when only the date would change — the case that must not become a commit. */
export function snapshotNumbersUnchanged(
  previous: AnalyticsSnapshot | null,
  next: AnalyticsSnapshot,
): boolean {
  if (previous === null) return false;
  const strip = (snapshot: AnalyticsSnapshot): string =>
    serializeSnapshot({ ...snapshot, asOf: '' });
  return strip(previous) === strip(next);
}
