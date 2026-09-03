/**
 * The rollup reads behind the admin Analytics view.
 *
 * Every function here returns counts that were actually stored, and the return type carries the
 * provenance with the number. `Measurement` is `{ value, provenance }` rather than a bare
 * number, so a figure cannot reach the UI without saying whether it was measured from visitor
 * events or set by the operator (Requirement 20.6). A label that lives next to the number in the
 * template is a label someone can forget to render; a label inside the value cannot be dropped
 * without the type complaining.
 *
 * `AnalyticsSummary.hasData` exists for the same reason. The empty state has to be a distinct
 * fact — "no events were recorded in this range" — and not the coincidence of every list being
 * empty, because those two are indistinguishable to a template that only sees zeros
 * (Requirements 20.9, 20.10).
 *
 * Nothing here extrapolates, projects, samples, or fills a gap. A range with no rows returns
 * empty lists and `hasData: false`; it never returns a plausible number.
 *
 * Design: Conversion → Analytics.
 * Requirements: 20.5, 20.6, 20.7, 20.8, 20.9, 20.10, 20.11, 20.12.
 */

import type { D1Database } from '@cloudflare/workers-types';

import type { AnalyticsEventType } from './rollup';

/**
 * How a figure came to exist.
 *
 * - `measured` — a count of recorded visitor events. A lower bound; see `HONEST_LIMITS`.
 * - `operator-set` — a value an operator entered, such as a lead's status. Exact by
 *   construction, and the only source of a conversion (Requirement 20.12).
 */
export type Provenance = 'measured' | 'operator-set';

export interface Measurement {
  value: number;
  provenance: Provenance;
}

export const measured = (value: number): Measurement => ({ value, provenance: 'measured' });
export const operatorSet = (value: number): Measurement => ({
  value,
  provenance: 'operator-set',
});

export interface RankedEntity {
  entity: string;
  count: Measurement;
}

export interface RankedQuery {
  query: string;
  count: Measurement;
  /** Results the query returned on its most recent occurrence, or null when not reported. */
  results: number | null;
}

export interface AnalyticsRange {
  /** Inclusive `YYYY-MM-DD` bounds. */
  from: string;
  to: string;
}

export interface AnalyticsSummary {
  range: AnalyticsRange;
  /** False when the range holds no recorded events at all — the empty state's trigger. */
  hasData: boolean;
  mostViewedProducts: RankedEntity[];
  mostViewedCategories: RankedEntity[];
  whatsappClicks: Measurement;
  callClicks: Measurement;
  quickEnquireOpens: Measurement;
  galleryOpens: Measurement;
  /** Enquiry *events* — the form's own report that it submitted. See the note below. */
  enquiryEvents: Measurement;
  /** Enquiry *records* — rows in the lead store. The number the operator can act on. */
  enquiryRecords: Measurement;
  /** Conversions, from operator-set lead status only. */
  conversions: Measurement;
  topSearches: RankedQuery[];
  zeroResultSearches: RankedQuery[];
}

/**
 * The standing caveats, stated in the admin UI itself rather than buried in documentation.
 *
 * They live here, next to the queries that produce the numbers, because they are properties of
 * how the numbers are collected — and a caveat kept in a template drifts from the collection it
 * describes (Requirements 20.7, 20.8).
 */
export const HONEST_LIMITS: readonly string[] = [
  'A WhatsApp or call figure counts the act of opening WhatsApp or a phone dialler. Whether a conversation happened, and whether an order followed, is not measurable here — that is recorded only by you, as a lead’s status.',
  'Every measured count is a lower bound. Ad blockers, privacy browsers and dropped background requests mean some visits are never reported, and the shortfall is not knowable.',
  'Page views are counted in the browser, so a visitor with JavaScript disabled is invisible to these figures entirely.',
  'There is no campaign attribution. Traffic source is limited to what the browser volunteers, and direct traffic cannot be attributed at all unless the link carried UTM parameters.',
  'Enquiry events and enquiry records are counted separately and will not always agree: an event can be reported without a record being stored, and a record can exist while its event was dropped.',
];

const DEFAULT_TOP_N = 10;

/** Today, and 29 days before it — the view's default range. */
export function defaultRange(now: Date = new Date()): AnalyticsRange {
  const to = now.toISOString().slice(0, 10);
  const fromDate = new Date(now.getTime() - 29 * 86_400_000);
  return { from: fromDate.toISOString().slice(0, 10), to };
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse `from`/`to`, falling back to the default range.
 *
 * An inverted range is swapped rather than refused: the operator plainly meant the interval
 * between the two dates, and an error message would be pedantry.
 */
export function parseRange(params: URLSearchParams, now: Date = new Date()): AnalyticsRange {
  const fallback = defaultRange(now);
  const from = params.get('from');
  const to = params.get('to');
  const start = from !== null && DATE_PATTERN.test(from) ? from : fallback.from;
  const end = to !== null && DATE_PATTERN.test(to) ? to : fallback.to;
  return start <= end ? { from: start, to: end } : { from: end, to: start };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

async function totalFor(
  db: D1Database,
  type: AnalyticsEventType,
  range: AnalyticsRange,
): Promise<number> {
  const row = await db
    .prepare(
      'SELECT COALESCE(SUM(count), 0) AS total FROM event_daily ' +
        'WHERE type = ? AND day >= ? AND day <= ?',
    )
    .bind(type, range.from, range.to)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

async function rankedFor(
  db: D1Database,
  type: AnalyticsEventType,
  range: AnalyticsRange,
  limit: number,
): Promise<RankedEntity[]> {
  const { results } = await db
    .prepare(
      'SELECT entity, SUM(count) AS total FROM event_daily ' +
        "WHERE type = ? AND day >= ? AND day <= ? AND entity <> '' " +
        'GROUP BY entity ORDER BY total DESC, entity ASC LIMIT ?',
    )
    .bind(type, range.from, range.to, limit)
    .all<{ entity: string; total: number }>();
  return (results ?? []).map((row) => ({ entity: row.entity, count: measured(row.total) }));
}

async function topSearchesFor(
  db: D1Database,
  range: AnalyticsRange,
  limit: number,
): Promise<RankedQuery[]> {
  const { results } = await db
    .prepare(
      'SELECT query, SUM(count) AS total, MIN(results) AS results FROM search_queries ' +
        'WHERE day >= ? AND day <= ? GROUP BY query ORDER BY total DESC, query ASC LIMIT ?',
    )
    .bind(range.from, range.to, limit)
    .all<{ query: string; total: number; results: number | null }>();
  return (results ?? []).map((row) => ({
    query: row.query,
    count: measured(row.total),
    results: row.results,
  }));
}

/**
 * Searches that returned nothing.
 *
 * `MAX(results) = 0` rather than `MIN`: a query that found results on any day in the range did
 * find results, and reporting it as a gap in the catalogue would send the operator to build a
 * product they already have. Rows with `results IS NULL` are excluded — unknown is not zero.
 */
async function zeroResultSearchesFor(
  db: D1Database,
  range: AnalyticsRange,
  limit: number,
): Promise<RankedQuery[]> {
  const { results } = await db
    .prepare(
      'SELECT query, SUM(count) AS total FROM search_queries ' +
        'WHERE day >= ? AND day <= ? AND results IS NOT NULL ' +
        'GROUP BY query HAVING MAX(results) = 0 ORDER BY total DESC, query ASC LIMIT ?',
    )
    .bind(range.from, range.to, limit)
    .all<{ query: string; total: number }>();
  return (results ?? []).map((row) => ({
    query: row.query,
    count: measured(row.total),
    results: 0,
  }));
}

/** Any recorded event in the range at all. Distinguishes "no data" from "all zeros". */
async function hasAnyEvents(db: D1Database, range: AnalyticsRange): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS present FROM event_daily WHERE day >= ? AND day <= ? LIMIT 1')
    .bind(range.from, range.to)
    .first<{ present: number }>();
  return row !== null;
}

/**
 * Lead records and conversions in the range, from the lead store.
 *
 * These are the only figures on the Analytics screen that are not visitor measurements, and they
 * are the only ones that are exact. A conversion comes from a lead's operator-set status and from
 * nowhere else (Requirement 20.12); `created_at` is the ISO instant, so the day bounds are string
 * comparisons against the day's edges.
 */
async function leadFigures(
  db: D1Database,
  range: AnalyticsRange,
): Promise<{ records: number; conversions: number }> {
  const row = await db
    .prepare(
      'SELECT COUNT(*) AS records, ' +
        "SUM(CASE WHEN status = 'CONVERTED' THEN 1 ELSE 0 END) AS conversions " +
        'FROM leads WHERE created_at >= ? AND created_at <= ?',
    )
    .bind(`${range.from}T00:00:00.000Z`, `${range.to}T23:59:59.999Z`)
    .first<{ records: number; conversions: number | null }>();
  return { records: row?.records ?? 0, conversions: row?.conversions ?? 0 };
}

/**
 * Everything the Analytics view shows, for one range.
 *
 * Sequential rather than `Promise.all`: D1 serialises a Worker's queries anyway, and a
 * sequential read makes a failing statement identifiable in the log instead of arriving as one
 * rejected aggregate.
 */
export async function analyticsSummary(
  db: D1Database,
  range: AnalyticsRange,
  topN: number = DEFAULT_TOP_N,
): Promise<AnalyticsSummary> {
  const leads = await leadFigures(db, range);

  return {
    range,
    hasData: (await hasAnyEvents(db, range)) || leads.records > 0,
    mostViewedProducts: await rankedFor(db, 'product_view', range, topN),
    mostViewedCategories: await rankedFor(db, 'category_view', range, topN),
    whatsappClicks: measured(await totalFor(db, 'whatsapp_click', range)),
    callClicks: measured(await totalFor(db, 'call_click', range)),
    quickEnquireOpens: measured(await totalFor(db, 'quick_enquire_open', range)),
    galleryOpens: measured(await totalFor(db, 'gallery_open', range)),
    enquiryEvents: measured(await totalFor(db, 'enquiry_submit', range)),
    // Stored rows, not reported events: the operator's inbox is the authority on how many
    // enquiries exist.
    enquiryRecords: operatorSet(leads.records),
    conversions: operatorSet(leads.conversions),
    topSearches: await topSearchesFor(db, range, topN),
    zeroResultSearches: await zeroResultSearchesFor(db, range, topN),
  };
}

/**
 * Measured view counts per product slug, for the Most Viewed sort (Requirement 20.11).
 *
 * Returned with the range it was measured over so the sort can be dated to its snapshot rather
 * than presented as current.
 */
export async function measuredViewCounts(
  db: D1Database,
  range: AnalyticsRange,
): Promise<{ range: AnalyticsRange; counts: Record<string, number> }> {
  const { results } = await db
    .prepare(
      'SELECT entity, SUM(count) AS total FROM event_daily ' +
        "WHERE type = 'product_view' AND day >= ? AND day <= ? AND entity <> '' GROUP BY entity",
    )
    .bind(range.from, range.to)
    .all<{ entity: string; total: number }>();
  const counts: Record<string, number> = {};
  for (const row of results ?? []) counts[row.entity] = row.total;
  return { range, counts };
}
