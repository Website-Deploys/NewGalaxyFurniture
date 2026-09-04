import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { D1Database } from '@cloudflare/workers-types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';

import {
  analyticsSummary,
  defaultRange,
  measuredViewCounts,
  parseRange,
  type AnalyticsRange,
} from '@/lib/analytics/queries';
import {
  countLeadsByStatus,
  csvField,
  generateLeadId,
  getLead,
  insertLead,
  leadsToCsv,
  parseLeadQuery,
  queryLeads,
  queryLeadsForExport,
  updateLead,
  type NewLead,
} from '@/lib/leads/store';
import {
  dayOf,
  foldBatch,
  MAX_BATCH_EVENTS,
  normalizeQuery,
  recordEvents,
  validateBatch,
  type AnalyticsEvent,
} from '@/lib/analytics/rollup';
import { eventsFromBody } from '@/lib/analytics/ingest';
import { isQuarantinedKey, quarantineKey } from '@/lib/leads/image';
import { resolveProductReference } from '@/lib/leads/resolve';
import { scoreSpam } from '@/lib/leads/spam';
import { demoSofa } from '../fixtures/products';

/**
 * Lead and event persistence, against **real local D1**.
 *
 * `getPlatformProxy` starts the same workerd-backed D1 the Worker gets in production, and the
 * schema comes from `migrations/0002_leads.sql` and `migrations/0003_events.sql` themselves — so a
 * syntax error, a missing index or a wrong primary key in either migration fails here rather than
 * at deploy time. That matters most for the analytics rollup: the additive `ON CONFLICT` upsert is
 * the whole of "counts are never lost", and an in-memory fake would let a wrong conflict target
 * pass unnoticed.
 *
 * Requirements: 6.7, 6.12, 6.13, 6.14, 6.15, 6.16, 20.1, 20.2, 20.3, 20.5, 20.10, 20.11, 20.12,
 * 25.2, 25.7.
 */

const MIGRATIONS = ['0002_leads.sql', '0003_events.sql'];

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let db: D1Database;

/**
 * Split the real migration into statements and run each.
 *
 * Comments are stripped to end-of-line wherever they appear, not only on whole lines. That is not
 * fussiness: `-- quarantined R2 prefix; admin-only` is a trailing comment containing a semicolon,
 * and a whole-line-only strip splits the `CREATE TABLE` in half and fails with
 * `incomplete input`. No string literal in these migrations contains `--`, so this is safe here.
 */
async function applyMigrations(database: D1Database): Promise<void> {
  for (const file of MIGRATIONS) {
    const path = fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url));
    const sql = readFileSync(path, 'utf8')
      .replace(/--[^\n]*/g, '')
      .trim();
    for (const statement of sql.split(';')) {
      const trimmed = statement.trim();
      if (trimmed === '') continue;
      await database.prepare(trimmed).run();
    }
  }
}

beforeAll(async () => {
  proxy = await getPlatformProxy({ configPath: './wrangler.toml', persist: false });
  db = (proxy.env as { DB: D1Database }).DB;
  await applyMigrations(db);
}, 120_000);

afterAll(async () => {
  await proxy?.dispose();
}, 60_000);

beforeEach(async () => {
  await db.prepare('DELETE FROM leads').run();
  await db.prepare('DELETE FROM event_daily').run();
  await db.prepare('DELETE FROM search_queries').run();
});

/* -------------------------------------------------------------------------- */
/* Leads                                                                      */
/* -------------------------------------------------------------------------- */

function lead(overrides: Partial<NewLead> = {}): NewLead {
  return {
    id: generateLeadId(),
    createdAt: '2026-03-14T09:30:00.000Z',
    type: 'QUICK_ENQUIRE',
    name: 'Asha Rao',
    phone: '+919513443606',
    message: 'Is the charcoal three-seater available?',
    productSlug: 'rolled-arm-sofa',
    productName: 'Rolled-Arm Three-Seater Sofa',
    productSku: 'NGF-SOF-4F2K9C',
    productUrl: '/product/rolled-arm-sofa',
    sourcePath: '/product/rolled-arm-sofa',
    ...overrides,
  };
}

describe('the leads migration produces the schema the store queries', () => {
  it('stores and reads back every field the admin list displays', async () => {
    const stored = lead({ budget: '₹40,000–50,000', dimensions: '7 ft', imageKey: 'quarantine/x' });
    await insertLead(db, stored);

    const read = await getLead(db, stored.id);
    expect(read).not.toBeNull();
    // Requirement 6.12 lists exactly these; all of them survive the round trip.
    expect(read).toMatchObject({
      name: 'Asha Rao',
      phone: '+919513443606',
      message: 'Is the charcoal three-seater available?',
      productName: 'Rolled-Arm Three-Seater Sofa',
      productSku: 'NGF-SOF-4F2K9C',
      sourcePath: '/product/rolled-arm-sofa',
      createdAt: '2026-03-14T09:30:00.000Z',
      status: 'NEW',
      spamScore: 0,
    });
    expect(read?.imageKey).toBe('quarantine/x');
  });

  it('always stores NEW, whatever the caller passes', async () => {
    // `insertLead` binds the literal 'NEW'. Requirement 6.7 says a stored lead starts there, and
    // making it unreachable from the input is stronger than validating it.
    const stored = lead();
    await insertLead(db, { ...stored, note: 'from the form' });
    expect((await getLead(db, stored.id))?.status).toBe('NEW');
  });

  it('keeps a spam-marked lead rather than discarding it', async () => {
    const marked = lead({ spamScore: 3 });
    await insertLead(db, marked);
    // Requirement 6.10: marked, not dropped. A false positive must not silently lose a customer.
    expect((await getLead(db, marked.id))?.spamScore).toBe(3);
    expect((await queryLeads(db, {})).total).toBe(1);
  });
});

describe('status and note updates', () => {
  it('sets each of the five statuses and attaches a note', async () => {
    const stored = lead();
    await insertLead(db, stored);

    for (const status of ['CONTACTED', 'FOLLOW_UP', 'CONVERTED', 'CLOSED', 'NEW'] as const) {
      const updated = await updateLead(db, stored.id, { status });
      expect(updated?.status).toBe(status);
    }

    const noted = await updateLead(db, stored.id, { note: 'Called at 4pm, will visit Saturday.' });
    expect(noted?.note).toBe('Called at 4pm, will visit Saturday.');
    // The status is untouched by a note-only patch, and vice versa.
    expect(noted?.status).toBe('NEW');

    const restatused = await updateLead(db, stored.id, { status: 'CONVERTED' });
    expect(restatused?.note).toBe('Called at 4pm, will visit Saturday.');
  });

  it('clears a note with null, and leaves it alone when omitted', async () => {
    const stored = lead();
    await insertLead(db, stored);
    await updateLead(db, stored.id, { note: 'first' });

    expect((await updateLead(db, stored.id, { status: 'CONTACTED' }))?.note).toBe('first');
    expect((await updateLead(db, stored.id, { note: null }))?.note).toBeNull();
  });

  it('never edits the evidence: name, phone, message and timestamp have no update path', async () => {
    const stored = lead();
    await insertLead(db, stored);
    await updateLead(db, stored.id, { status: 'CLOSED', note: 'x' });

    const read = await getLead(db, stored.id);
    expect(read?.name).toBe(stored.name);
    expect(read?.phone).toBe(stored.phone);
    expect(read?.message).toBe(stored.message);
    expect(read?.createdAt).toBe(stored.createdAt);
  });
});

describe('search, filter and pagination', () => {
  beforeEach(async () => {
    await insertLead(
      db,
      lead({
        name: 'Asha Rao',
        phone: '+919513443606',
        message: 'Sofa enquiry',
        createdAt: '2026-03-01T10:00:00.000Z',
      }),
    );
    await insertLead(
      db,
      lead({
        name: 'Bhavna Iyer',
        phone: '+918147083703',
        message: 'Dining table for six',
        productName: 'Six-Seater Dining Table',
        productSku: 'NGF-DIN-9Z1X2C',
        createdAt: '2026-03-10T10:00:00.000Z',
      }),
    );
    await insertLead(
      db,
      lead({ name: 'Chetan Kumar', message: 'Bed frame', createdAt: '2026-03-20T10:00:00.000Z' }),
    );
  });

  it('returns newest first', async () => {
    const page = await queryLeads(db, {});
    expect(page.items.map((entry) => entry.name)).toEqual([
      'Chetan Kumar',
      'Bhavna Iyer',
      'Asha Rao',
    ]);
    expect(page.filtered).toBe(false);
  });

  it('searches name, phone, message, product name and SKU', async () => {
    for (const [query, expected] of [
      ['Bhavna', 'Bhavna Iyer'],
      ['8147083703', 'Bhavna Iyer'],
      ['Dining table', 'Bhavna Iyer'],
      ['NGF-DIN-9Z1X2C', 'Bhavna Iyer'],
      ['Six-Seater', 'Bhavna Iyer'],
    ] as const) {
      const page = await queryLeads(db, { q: query });
      expect(
        page.items.map((entry) => entry.name),
        `searching "${query}"`,
      ).toEqual([expected]);
      expect(page.filtered).toBe(true);
    }
  });

  it('treats a LIKE metacharacter as a literal, not a wildcard', async () => {
    // A search for `%` must not match every lead. The escape is what makes free-text search over
    // personal data safe to expose.
    expect((await queryLeads(db, { q: '%' })).total).toBe(0);
    expect((await queryLeads(db, { q: '_' })).total).toBe(0);

    await insertLead(db, lead({ name: 'Discount Hunter', message: '100% cotton please' }));
    expect((await queryLeads(db, { q: '100%' })).items.map((e) => e.name)).toEqual([
      'Discount Hunter',
    ]);
  });

  it('is not injectable through the search box', async () => {
    for (const attack of ["' OR 1=1 --", "'; DROP TABLE leads; --", "\\' OR '1'='1"]) {
      const page = await queryLeads(db, { q: attack });
      expect(page.total).toBe(0);
    }
    // The table is still there with all three seeded leads, which is the assertion that matters.
    expect((await queryLeads(db, {})).total).toBe(3);
  });

  it('filters by status and by inclusive date range', async () => {
    const all = await queryLeads(db, {});
    const middle = all.items.find((entry) => entry.name === 'Bhavna Iyer');
    await updateLead(db, middle!.id, { status: 'CONVERTED' });

    expect((await queryLeads(db, { status: 'CONVERTED' })).total).toBe(1);
    expect((await queryLeads(db, { status: 'NEW' })).total).toBe(2);

    // Inclusive at both ends: a lead received on the `to` date must be included.
    expect((await queryLeads(db, { from: '2026-03-10', to: '2026-03-20' })).total).toBe(2);
    expect((await queryLeads(db, { from: '2026-03-20', to: '2026-03-20' })).total).toBe(1);
    expect((await queryLeads(db, { from: '2026-04-01' })).total).toBe(0);

    // Combined, status AND range.
    expect(
      (await queryLeads(db, { status: 'CONVERTED', from: '2026-03-01', to: '2026-03-31' })).total,
    ).toBe(1);
    expect((await queryLeads(db, { status: 'CONVERTED', from: '2026-03-15' })).total).toBe(0);
  });

  it('parses the query string, ignoring anything malformed', () => {
    const parsed = parseLeadQuery(
      new URLSearchParams({
        status: 'FOLLOW_UP',
        q: '  sofa  ',
        from: '2026-03-01',
        to: 'not-a-date',
        page: '-4',
      }),
    );
    expect(parsed).toEqual({ status: 'FOLLOW_UP', q: 'sofa', from: '2026-03-01' });

    expect(parseLeadQuery(new URLSearchParams({ status: 'BOGUS' }))).toEqual({});
  });

  it('clamps the page to the available range rather than returning an empty page', async () => {
    const page = await queryLeads(db, { page: 99 });
    expect(page.page).toBe(1);
    expect(page.items.length).toBeGreaterThan(0);
  });
});

describe('CSV export', () => {
  it('is scoped to the same filter as the list', async () => {
    await insertLead(db, lead({ name: 'In range', createdAt: '2026-03-10T10:00:00.000Z' }));
    await insertLead(db, lead({ name: 'Out of range', createdAt: '2026-05-10T10:00:00.000Z' }));

    const query = { from: '2026-03-01', to: '2026-03-31' };
    const listed = await queryLeads(db, query);
    const exported = await queryLeadsForExport(db, query);

    expect(exported.map((entry) => entry.id)).toEqual(listed.items.map((entry) => entry.id));
    const csv = leadsToCsv(exported);
    expect(csv).toContain('In range');
    expect(csv).not.toContain('Out of range');
  });

  it('neutralises a formula so a lead cannot execute in the operator’s spreadsheet', async () => {
    // The attack: a name of `=HYPERLINK(...)` is a live formula when the CSV is opened.
    await insertLead(db, lead({ name: '=HYPERLINK("http://evil.test","click")' }));
    const csv = leadsToCsv(await queryLeadsForExport(db, {}));

    expect(csv).not.toContain('"=HYPERLINK');
    expect(csv).toContain('"\'=HYPERLINK');
    for (const dangerous of ['=cmd', '+1', '-1', '@SUM(A1)']) {
      expect(csvField(dangerous).startsWith('"\'')).toBe(true);
    }
  });

  it('quotes and escapes so a message with commas, quotes and newlines survives', async () => {
    await insertLead(db, lead({ name: 'Quote "Me"', message: 'one, two\nthree' }));
    const csv = leadsToCsv(await queryLeadsForExport(db, {}));
    expect(csv).toContain('"Quote ""Me"""');
    expect(csv).toContain('"one, two\nthree"');
    // Header present, CRLF-terminated rows.
    expect(csv.startsWith('"id","received"')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('exports a header row even with no leads, so an empty export is still a valid file', () => {
    const csv = leadsToCsv([]);
    expect(csv.trim().split('\r\n')).toHaveLength(1);
  });
});

describe('the dashboard count', () => {
  it('counts by status, and reports a real zero as zero', async () => {
    expect(await countLeadsByStatus(db)).toEqual({
      NEW: 0,
      CONTACTED: 0,
      FOLLOW_UP: 0,
      CONVERTED: 0,
      CLOSED: 0,
    });

    const a = lead();
    const b = lead();
    await insertLead(db, a);
    await insertLead(db, b);
    await updateLead(db, b.id, { status: 'CONTACTED' });

    const counts = await countLeadsByStatus(db);
    expect(counts.NEW).toBe(1);
    expect(counts.CONTACTED).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Events and the daily rollup                                                */
/* -------------------------------------------------------------------------- */

const AT = Date.UTC(2026, 2, 14, 9, 0, 0);

function event(overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return { t: 'product_view', e: 'rolled-arm-sofa', ts: AT, ...overrides };
}

describe('batch validation', () => {
  it('drops unknown types, out-of-window timestamps and malformed entries', () => {
    const { events, rejected } = validateBatch(
      [
        event(),
        { t: 'not_a_type', e: 'x', ts: AT },
        { t: 'product_view', ts: AT - 11 * 60_000 },
        { t: 'product_view', ts: AT + 11 * 60_000 },
        { t: 'product_view' },
        'not an object',
        null,
      ],
      AT,
    );
    expect(events).toHaveLength(1);
    expect(rejected).toBe(6);
  });

  it('keeps the good entries in a partly bad batch', () => {
    // A beacon cannot usefully retry, so discarding nine good events because of one bad one loses
    // more truth than keeping them.
    const { events } = validateBatch([event(), { t: 'bogus', ts: AT }, event()], AT);
    expect(events).toHaveLength(2);
  });

  it('truncates a batch above the 20-event ceiling and counts the remainder as rejected', () => {
    const { events, rejected } = validateBatch(
      Array.from({ length: 30 }, () => event()),
      AT,
    );
    expect(events).toHaveLength(MAX_BATCH_EVENTS);
    expect(rejected).toBe(10);
  });

  it('normalises a search query and refuses one with no text', () => {
    expect(normalizeQuery('  Sofa   SET  ')).toBe('sofa set');
    const { events } = validateBatch([{ t: 'search', e: '   ', ts: AT }], AT);
    expect(events).toHaveLength(0);
  });

  it('bounds the entity length', () => {
    const { events } = validateBatch([{ t: 'product_view', e: 'x'.repeat(500), ts: AT }], AT);
    expect(events[0]?.e?.length).toBe(120);
  });

  it('accepts a non-array as an empty batch rather than throwing', () => {
    expect(validateBatch(null, AT).events).toHaveLength(0);
    expect(validateBatch({ t: 'product_view' }, AT).events).toHaveLength(0);
  });
});

describe('folding and the daily-rollup upsert', () => {
  it('folds repeated events in one batch into a single increment', () => {
    const { tallies } = foldBatch([event(), event(), event()]);
    expect(tallies).toHaveLength(1);
    expect(tallies[0]?.count).toBe(3);
  });

  it('uses the event’s own day, so a batch flushed across midnight splits correctly', () => {
    const beforeMidnight = Date.UTC(2026, 2, 14, 23, 59, 0);
    const afterMidnight = Date.UTC(2026, 2, 15, 0, 1, 0);
    const { tallies } = foldBatch([event({ ts: beforeMidnight }), event({ ts: afterMidnight })]);
    expect(tallies.map((tally) => tally.day).sort()).toEqual(['2026-03-14', '2026-03-15']);
  });

  it('adds rather than replaces across separate writes', async () => {
    await recordEvents(db, [event(), event()]);
    await recordEvents(db, [event()]);

    const row = await db
      .prepare('SELECT count FROM event_daily WHERE day = ? AND type = ? AND entity = ?')
      .bind(dayOf(AT), 'product_view', 'rolled-arm-sofa')
      .first<{ count: number }>();
    // The upsert is `count = count + excluded.count`. A replacing upsert would report 1 here, and
    // every count in the system would be "the size of the last batch".
    expect(row?.count).toBe(3);
  });

  it('keeps one row per (day, type, entity) — the primary key the migration declares', async () => {
    await recordEvents(db, [
      event(),
      event({ e: 'another-sofa' }),
      event({ t: 'category_view', e: 'sofas' }),
      event({ ts: AT + 86_400_000 }),
    ]);
    const { results } = await db.prepare('SELECT * FROM event_daily').all();
    expect(results).toHaveLength(4);
  });

  it('records a search’s result count, and does not overwrite a known one with an unknown', async () => {
    await recordEvents(db, [{ t: 'search', e: 'sofa', ts: AT, r: 0 }]);
    await recordEvents(db, [{ t: 'search', e: 'sofa', ts: AT }]);

    const row = await db
      .prepare('SELECT count, results FROM search_queries WHERE day = ? AND query = ?')
      .bind(dayOf(AT), 'sofa')
      .first<{ count: number; results: number | null }>();
    expect(row?.count).toBe(2);
    // COALESCE keeps the 0. Losing it would turn "nobody found anything" into "unknown".
    expect(row?.results).toBe(0);
  });

  it('stores no per-visitor identifier — there is no column for one', async () => {
    await recordEvents(db, [event()]);
    const { results } = await db.prepare('SELECT * FROM event_daily LIMIT 1').all();
    const columns = Object.keys(results[0] ?? {});
    expect(columns.sort()).toEqual(['count', 'day', 'entity', 'type']);
  });

  it('writes nothing for an empty batch', async () => {
    const written = await recordEvents(db, []);
    expect(written).toEqual({ tallies: 0, queries: 0 });
  });
});

/* -------------------------------------------------------------------------- */
/* The analytics summary                                                      */
/* -------------------------------------------------------------------------- */

const RANGE: AnalyticsRange = { from: '2026-03-01', to: '2026-03-31' };

describe('the analytics summary', () => {
  it('reports no data for an empty range rather than a set of zeros', async () => {
    const summary = await analyticsSummary(db, RANGE);
    // `hasData` is what the empty state hangs on: all-zero figures and no-measurement are
    // different facts (Requirements 20.9, 20.10).
    expect(summary.hasData).toBe(false);
    expect(summary.mostViewedProducts).toEqual([]);
    expect(summary.whatsappClicks).toEqual({ value: 0, provenance: 'measured' });
  });

  it('labels every figure as measured or operator-set', async () => {
    await recordEvents(db, [event(), event({ t: 'whatsapp_click', e: 'rolled-arm-sofa' })]);
    await insertLead(db, lead({ createdAt: '2026-03-14T09:00:00.000Z' }));

    const summary = await analyticsSummary(db, RANGE);
    expect(summary.hasData).toBe(true);

    for (const measurement of [
      summary.whatsappClicks,
      summary.callClicks,
      summary.enquiryEvents,
      summary.galleryOpens,
      summary.quickEnquireOpens,
    ]) {
      expect(measurement.provenance).toBe('measured');
    }
    // Stored records and conversions come from the operator's own inbox, not from visitor events.
    expect(summary.enquiryRecords.provenance).toBe('operator-set');
    expect(summary.conversions.provenance).toBe('operator-set');
    for (const ranked of summary.mostViewedProducts) {
      expect(ranked.count.provenance).toBe('measured');
    }
  });

  it('ranks views within the range and excludes days outside it', async () => {
    await recordEvents(db, [
      event({ e: 'sofa-a' }),
      event({ e: 'sofa-a' }),
      event({ e: 'sofa-b' }),
      event({ e: 'sofa-c', ts: Date.UTC(2026, 4, 1) }),
      event({ t: 'category_view', e: 'sofas' }),
    ]);

    const summary = await analyticsSummary(db, RANGE);
    expect(summary.mostViewedProducts.map((entry) => entry.entity)).toEqual(['sofa-a', 'sofa-b']);
    expect(summary.mostViewedProducts[0]?.count.value).toBe(2);
    expect(summary.mostViewedCategories.map((entry) => entry.entity)).toEqual(['sofas']);
  });

  it('counts conversions only from operator-set lead status', async () => {
    const a = lead({ createdAt: '2026-03-05T09:00:00.000Z' });
    const b = lead({ createdAt: '2026-03-06T09:00:00.000Z' });
    await insertLead(db, a);
    await insertLead(db, b);

    // No visitor event can produce a conversion, so a pile of them changes nothing.
    await recordEvents(db, [
      event({ t: 'enquiry_submit', e: '' }),
      event({ t: 'whatsapp_click', e: 'x' }),
      event({ t: 'call_click', e: 'x' }),
    ]);
    expect((await analyticsSummary(db, RANGE)).conversions.value).toBe(0);

    await updateLead(db, b.id, { status: 'CONVERTED' });
    const summary = await analyticsSummary(db, RANGE);
    expect(summary.conversions.value).toBe(1);
    expect(summary.enquiryRecords.value).toBe(2);
  });

  it('separates enquiry events from enquiry records, because they can disagree', async () => {
    await recordEvents(db, [event({ t: 'enquiry_submit', e: '' })]);
    const summary = await analyticsSummary(db, RANGE);
    expect(summary.enquiryEvents.value).toBe(1);
    expect(summary.enquiryRecords.value).toBe(0);
  });

  it('lists frequent searches and, separately, those that found nothing', async () => {
    await recordEvents(db, [
      { t: 'search', e: 'sofa', ts: AT, r: 12 },
      { t: 'search', e: 'sofa', ts: AT, r: 12 },
      { t: 'search', e: 'recliner', ts: AT, r: 0 },
      { t: 'search', e: 'garden swing', ts: AT, r: 0 },
    ]);

    const summary = await analyticsSummary(db, RANGE);
    expect(summary.topSearches[0]).toMatchObject({ query: 'sofa', results: 12 });
    expect(summary.zeroResultSearches.map((entry) => entry.query).sort()).toEqual([
      'garden swing',
      'recliner',
    ]);
  });

  it('does not call a query zero-result if it found something on any day in the range', async () => {
    await recordEvents(db, [{ t: 'search', e: 'recliner', ts: AT, r: 0 }]);
    await recordEvents(db, [{ t: 'search', e: 'recliner', ts: AT + 86_400_000, r: 3 }]);
    // Reporting it as a gap would send the operator to build a product they already list.
    expect((await analyticsSummary(db, RANGE)).zeroResultSearches).toEqual([]);
  });

  it('excludes a search with an unknown result count from the zero-result list', async () => {
    await recordEvents(db, [{ t: 'search', e: 'mystery', ts: AT }]);
    expect((await analyticsSummary(db, RANGE)).zeroResultSearches).toEqual([]);
  });

  it('exposes measured view counts for the Most Viewed sort, dated to its range', async () => {
    await recordEvents(db, [event({ e: 'sofa-a' }), event({ e: 'sofa-a' })]);
    const measured = await measuredViewCounts(db, RANGE);
    expect(measured.counts['sofa-a']).toBe(2);
    expect(measured.range).toEqual(RANGE);
  });
});

/* -------------------------------------------------------------------------- */
/* The public endpoints' own shapes, against the same D1                      */
/* -------------------------------------------------------------------------- */

describe('a lead stored the way POST /api/leads stores one', () => {
  it('keeps the server-resolved product values and the quarantined image key', async () => {
    // The record below is exactly what the endpoint builds: the product fields come from
    // `resolveProductReference` against `getCatalogue()`, the image key from `quarantineKey`, and
    // the timestamp from the server clock (Requirements 6.6, 6.7, 6.11).
    const product = resolveProductReference(demoSofa.slug, [demoSofa], 'https://example.test');
    expect(product.ok).toBe(true);
    if (!product.ok) return;

    const id = generateLeadId();
    await insertLead(db, {
      id,
      createdAt: new Date(AT).toISOString(),
      type: 'QUICK_ENQUIRE',
      name: 'Asha Rao',
      phone: '+919513443606',
      message: 'Is this available in walnut?',
      productSlug: product.product.slug,
      productName: product.product.name,
      productSku: product.product.sku,
      productUrl: product.product.url,
      imageKey: quarantineKey(id, 'webp'),
      sourcePath: '/product/rolled-arm-sofa',
    });

    const stored = await getLead(db, id);
    expect(stored?.productName).toBe(demoSofa.name);
    expect(stored?.productSku).toBe(demoSofa.sku);
    expect(stored?.productUrl).toBe(`https://example.test/product/${demoSofa.slug}`);
    expect(isQuarantinedKey(stored?.imageKey ?? '')).toBe(true);
    expect(stored?.status).toBe('NEW');
  });

  it('keeps a lead the spam heuristics flagged, with the reasons on the note', async () => {
    const assessment = scoreSpam({
      name: 'SEO Growth',
      message: 'rank your website — https://a.test https://b.test https://c.test',
    });
    expect(assessment.score).toBeGreaterThan(0);

    const id = generateLeadId();
    await insertLead(db, {
      id,
      createdAt: new Date(AT).toISOString(),
      type: 'CONTACT',
      name: 'SEO Growth',
      phone: '+919513443606',
      message: 'rank your website',
      spamScore: assessment.score,
      note: `Flagged: ${assessment.reasons.join(' ')}`,
    });

    // Requirement 6.10: marked, present, and readable — not discarded.
    const stored = await getLead(db, id);
    expect(stored?.spamScore).toBe(assessment.score);
    expect(stored?.note).toMatch(/^Flagged: /);
    expect((await queryLeads(db, {})).total).toBe(1);
  });
});

describe('a batch ingested the way POST /api/events ingests one', () => {
  it('validates the posted wrapper and folds it into the daily counters', async () => {
    const batch = {
      events: [
        { t: 'product_view', e: 'rolled-arm-sofa', ts: AT },
        { t: 'product_view', e: 'rolled-arm-sofa', ts: AT },
        { t: 'search', e: '  Rolled Arm  ', ts: AT, r: 3 },
        // Dropped: an unknown type, and a timestamp beyond the window.
        { t: 'page_view', e: 'home', ts: AT },
        { t: 'product_view', e: 'x', ts: AT - 20 * 60_000 },
      ],
    };

    const { events, rejected, submitted } = eventsFromBody(batch, AT);
    expect(submitted).toBe(5);
    expect(rejected).toBe(2);
    await recordEvents(db, events);

    const view = await db
      .prepare('SELECT count FROM event_daily WHERE type = ? AND entity = ?')
      .bind('product_view', 'rolled-arm-sofa')
      .first<{ count: number }>();
    expect(view?.count).toBe(2);

    // The search query is normalised before it becomes a key, so `"  Rolled Arm  "` and
    // `"rolled arm"` are one row rather than two.
    const search = await db
      .prepare('SELECT query, count, results FROM search_queries')
      .first<{ query: string; count: number; results: number }>();
    expect(search).toMatchObject({ query: 'rolled arm', count: 1, results: 3 });
  });

  it('writes nothing at all for a body that is not a batch', async () => {
    for (const body of [null, 'nope', { events: 'nope' }, {}]) {
      const { events } = eventsFromBody(body, AT);
      await recordEvents(db, events);
    }
    const { results } = await db.prepare('SELECT * FROM event_daily').all();
    expect(results).toHaveLength(0);
  });
});

describe('range parsing', () => {
  it('defaults to the last 30 days inclusive', () => {
    const range = defaultRange(new Date('2026-03-30T12:00:00.000Z'));
    expect(range).toEqual({ from: '2026-03-01', to: '2026-03-30' });
  });

  it('ignores a malformed bound and swaps an inverted range', () => {
    const now = new Date('2026-03-30T12:00:00.000Z');
    expect(parseRange(new URLSearchParams({ from: 'yesterday' }), now).from).toBe('2026-03-01');
    expect(parseRange(new URLSearchParams({ from: '2026-03-20', to: '2026-03-10' }), now)).toEqual({
      from: '2026-03-10',
      to: '2026-03-20',
    });
  });
});
