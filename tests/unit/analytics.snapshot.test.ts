import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { D1Database } from '@cloudflare/workers-types';
import { getPlatformProxy } from 'wrangler';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitHubContentClient } from '@/lib/github/client';
import { commitSubject, parseCommitTrailers } from '@/lib/github/commit-message';
import { resolveContentPath } from '@/lib/github/paths';
import { runAnalyticsSnapshot, SNAPSHOT_ACTOR } from '@/lib/analytics/snapshot-cron';
import {
  buildAnalyticsSnapshot,
  LIFETIME_FROM,
  serializeSnapshot,
  snapshotNumbersUnchanged,
  snapshotRanges,
  SNAPSHOT_PATH,
  utcDay,
  VELOCITY_WINDOW_DAYS,
} from '@/lib/analytics/snapshot';
import { resolveRanking, sortOptionLabel } from '@/lib/search/sort';
import type { SearchDoc } from '@/lib/search/types';

import { GitHubApiStub } from '../fixtures/github-api';

/**
 * The nightly analytics snapshot (task 18.5), end to end minus the platform's own scheduler.
 *
 * The D1 half runs against **real local D1** through `getPlatformProxy`, with the schema taken from
 * the shipped migration, because the whole artifact is derived from a `SUM(count) GROUP BY entity`
 * over `event_daily` and an in-memory fake of that query would be a fake of the thing under test. The
 * GitHub half runs against the protocol stub, so the write goes through the real client — and
 * therefore the real path allowlist, the real sha precondition, and the real commit-message renderer.
 *
 * What the assertions are actually about:
 *
 * - the snapshot is written to the one allowlisted path, with `[skip ci]` on the subject;
 * - the commit is attributed to an automation rather than borrowing an operator's name;
 * - the numbers come from the same `measuredViewCounts` query the admin view reads;
 * - a night whose numbers have not moved produces no commit at all;
 * - a snapshot with nothing measured produces no file, so the sorts stay honestly curated;
 * - the file the cron writes is one the *reader* accepts and the sort labels `measured`.
 *
 * Requirements: 3.14, 3.15, 20.11, 14.10.
 */

const MIGRATIONS = ['0003_events.sql'];

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let db: D1Database;

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
  await db.prepare('DELETE FROM event_daily').run();
});

/** The cron fires at 19:30 UTC, so "yesterday" is the last complete day. */
const NOW = new Date('2025-03-11T19:30:00.000Z');
const YESTERDAY = '2025-03-10';

async function recordViews(day: string, counts: Record<string, number>): Promise<void> {
  for (const [slug, count] of Object.entries(counts)) {
    await db
      .prepare(
        'INSERT INTO event_daily (day, type, entity, count) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(day, type, entity) DO UPDATE SET count = count + excluded.count',
      )
      .bind(day, 'product_view', slug, count)
      .run();
  }
}

function stubClient(files: Record<string, string> = {}): {
  client: GitHubContentClient;
  stub: GitHubApiStub;
} {
  const stub = new GitHubApiStub({ files });
  const client = new GitHubContentClient({
    token: 'ghp_test_token_value_0000000000000000',
    repo: stub.repo,
    branch: stub.branch,
    fetchImpl: stub.fetch,
  });
  return { client, stub };
}

describe('the snapshot ranges', () => {
  it('measures complete days only, ending yesterday', () => {
    const ranges = snapshotRanges(NOW);
    expect(ranges.lifetime).toEqual({ from: LIFETIME_FROM, to: YESTERDAY });
    // Seven complete days, inclusive of both bounds.
    expect(ranges.velocity).toEqual({ from: '2025-03-04', to: YESTERDAY });
  });

  it('does not shift with the hour the cron happens to run', () => {
    const early = snapshotRanges(new Date('2025-03-11T00:05:00.000Z'));
    const late = snapshotRanges(new Date('2025-03-11T23:55:00.000Z'));
    expect(early).toEqual(late);
  });

  it('crosses a month and a year boundary correctly', () => {
    expect(snapshotRanges(new Date('2025-03-01T19:30:00.000Z')).lifetime.to).toBe('2025-02-28');
    // Yesterday is 2024-12-31, and seven complete days inclusive of both bounds starts on the 25th.
    expect(snapshotRanges(new Date('2025-01-01T19:30:00.000Z')).velocity).toEqual({
      from: '2024-12-25',
      to: '2024-12-31',
    });
    expect(utcDay(new Date('2024-02-29T12:00:00.000Z'))).toBe('2024-02-29');
    expect(VELOCITY_WINDOW_DAYS).toBe(7);
  });
});

describe('the snapshot record', () => {
  it('omits an empty table rather than writing one, and is null when nothing is measured', () => {
    expect(buildAnalyticsSnapshot({ asOf: YESTERDAY, views: {}, velocity: {} })).toBeNull();
    const viewsOnly = buildAnalyticsSnapshot({
      asOf: YESTERDAY,
      views: { sofa: 4 },
      velocity: {},
    });
    expect(viewsOnly).toEqual({ asOf: YESTERDAY, views: { sofa: 4 } });
    expect(viewsOnly).not.toHaveProperty('velocity');
  });

  it('drops zeroes and nonsense: a zero is the absence of a measurement', () => {
    const snapshot = buildAnalyticsSnapshot({
      asOf: YESTERDAY,
      views: { sofa: 3, bed: 0, chair: Number.NaN, '': 9 },
      velocity: { sofa: 1 },
    });
    expect(snapshot?.views).toEqual({ sofa: 3 });
  });

  it('serialises deterministically, so identical numbers produce identical bytes', () => {
    const a = serializeSnapshot({ asOf: YESTERDAY, views: { b: 2, a: 1 } });
    const b = serializeSnapshot({ asOf: YESTERDAY, views: { a: 1, b: 2 } });
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
    expect(a).toContain('"asOf"');
  });

  it('treats a night with the same numbers as unchanged, and a moved number as changed', () => {
    const previous = { asOf: '2025-03-09', views: { sofa: 4 } };
    expect(snapshotNumbersUnchanged(previous, { asOf: YESTERDAY, views: { sofa: 4 } })).toBe(true);
    expect(snapshotNumbersUnchanged(previous, { asOf: YESTERDAY, views: { sofa: 5 } })).toBe(false);
    expect(snapshotNumbersUnchanged(null, { asOf: YESTERDAY, views: { sofa: 4 } })).toBe(false);
  });
});

describe('the scheduled run', () => {
  it('writes the snapshot to the one allowlisted path and commits it with [skip ci]', async () => {
    await recordViews('2025-03-05', { 'oak-bed': 5, 'linen-sofa': 2 });
    await recordViews('2025-03-09', { 'linen-sofa': 7 });
    // A partial day that must not be counted: today is still accumulating.
    await recordViews('2025-03-11', { 'oak-bed': 100 });
    // Older than the velocity window, inside lifetime.
    await recordViews('2025-01-04', { 'teak-table': 3 });

    const { client, stub } = stubClient();
    const outcome = await runAnalyticsSnapshot({ db, client, now: NOW });

    expect(outcome.kind).toBe('written');
    if (outcome.kind !== 'written') return;
    expect(outcome.asOf).toBe(YESTERDAY);
    expect(outcome.products).toBe(3);

    const written = stub.files.get(SNAPSHOT_PATH);
    expect(written).toBeDefined();
    const record = JSON.parse(written?.content ?? '{}') as {
      asOf: string;
      views: Record<string, number>;
      velocity: Record<string, number>;
    };

    // Lifetime totals: every complete day, today excluded.
    expect(record.views).toEqual({ 'oak-bed': 5, 'linen-sofa': 9, 'teak-table': 3 });
    // Velocity: the seven days ending yesterday, so January is out and today is out.
    expect(record.velocity).toEqual({ 'oak-bed': 5, 'linen-sofa': 9 });
    expect(record.asOf).toBe(YESTERDAY);

    const commit = stub.commits.at(-1);
    expect(commit?.paths).toEqual([SNAPSHOT_PATH]);
    expect(commitSubject(commit?.message ?? '')).toContain('[skip ci]');
    expect(commitSubject(commit?.message ?? '')).toContain('content(analytics)');
  });

  it('attributes the commit to an automation rather than to an operator', async () => {
    await recordViews('2025-03-09', { 'linen-sofa': 3 });
    const { client, stub } = stubClient();
    await runAnalyticsSnapshot({ db, client, now: NOW });

    const trailers = parseCommitTrailers(stub.commits.at(-1)?.message ?? '');
    expect(trailers.Actor).toBe('nightly analytics snapshot (automated)');
    expect(trailers.Action).toBe('SNAPSHOT');
    // No status trailer: a snapshot is not a lifecycle transition, and this path cannot make one.
    expect(trailers.Status).toBeUndefined();
    expect(SNAPSHOT_ACTOR.automated).toBe('nightly analytics snapshot');
  });

  it('writes nothing at all when nothing has been measured', async () => {
    const { client, stub } = stubClient();
    const outcome = await runAnalyticsSnapshot({ db, client, now: NOW });
    expect(outcome).toEqual({ kind: 'no-data', asOf: YESTERDAY });
    expect(stub.files.has(SNAPSHOT_PATH)).toBe(false);
    expect(stub.commits).toEqual([]);
  });

  it('makes no commit on a night whose numbers have not moved', async () => {
    await recordViews('2025-03-09', { 'linen-sofa': 3 });
    const first = stubClient();
    await runAnalyticsSnapshot({ db, client: first.client, now: NOW });
    const stored = first.stub.files.get(SNAPSHOT_PATH)?.content ?? '';

    // The next night: same data, one day later.
    const second = stubClient({ [SNAPSHOT_PATH]: stored });
    const outcome = await runAnalyticsSnapshot({
      db,
      client: second.client,
      now: new Date('2025-03-12T19:30:00.000Z'),
    });
    expect(outcome.kind).toBe('unchanged');
    expect(second.stub.commits).toEqual([]);
    expect(second.stub.files.get(SNAPSHOT_PATH)?.content).toBe(stored);
  });

  it('updates the stored file in place, passing the sha it read', async () => {
    await recordViews('2025-03-09', { 'linen-sofa': 3 });
    const first = stubClient();
    await runAnalyticsSnapshot({ db, client: first.client, now: NOW });
    const stored = first.stub.files.get(SNAPSHOT_PATH)?.content ?? '';

    await recordViews('2025-03-10', { 'linen-sofa': 4 });
    const second = stubClient({ [SNAPSHOT_PATH]: stored });
    const outcome = await runAnalyticsSnapshot({ db, client: second.client, now: NOW });

    expect(outcome.kind).toBe('written');
    const record = JSON.parse(second.stub.files.get(SNAPSHOT_PATH)?.content ?? '{}') as {
      views: Record<string, number>;
    };
    expect(record.views['linen-sofa']).toBe(7);
    // Exactly one file, exactly one commit: the cron is not a bulk writer.
    expect(second.stub.commits).toHaveLength(1);
    expect([...second.stub.files.keys()]).toEqual([SNAPSHOT_PATH]);
  });

  it('reports a failed write without throwing, and leaves the stored file alone', async () => {
    await recordViews('2025-03-09', { 'linen-sofa': 3 });
    const { client, stub } = stubClient();
    stub.forceStatusOnce = 500;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const outcome = await runAnalyticsSnapshot({ db, client, now: NOW });
      expect(outcome).toEqual({ kind: 'failed', reason: 'write' });
      expect(stub.files.has(SNAPSHOT_PATH)).toBe(false);
      // The detail is logged, and the log carries no credential.
      const logged = spy.mock.calls.flat().map(String).join(' ');
      expect(logged).toContain('analytics-snapshot');
      expect(logged).not.toContain('ghp_test_token_value_0000000000000000');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the artifact the build then reads', () => {
  it('is at a path the allowlist admits, and only that one', () => {
    expect(resolveContentPath(SNAPSHOT_PATH)).toBe(SNAPSHOT_PATH);
    for (const neighbour of [
      'data/snapshots/rankings.json',
      'data/snapshots/analytics.json.bak',
      'data/snapshots/2025/analytics.json',
      'data/snapshots/../site/settings.json',
    ]) {
      expect(resolveContentPath(neighbour), neighbour).toBeNull();
    }
  });

  it('turns the Most Viewed and Trending sorts from curated into measured', async () => {
    await recordViews('2025-03-09', { 'linen-sofa': 9, 'oak-bed': 4 });
    const { client, stub } = stubClient();
    await runAnalyticsSnapshot({ db, client, now: NOW });

    const snapshot = JSON.parse(stub.files.get(SNAPSHOT_PATH)?.content ?? '{}') as {
      asOf: string;
      views: Record<string, number>;
      velocity: Record<string, number>;
    };

    /** The sort only reads the slug, but the snapshot has to cover real documents to count. */
    const doc = (slug: string): SearchDoc => ({
      i: slug,
      n: slug,
      k: 'NGF-SOF-000001',
      c: 'sofas',
      o: [],
      t: [],
      p: 1000,
      st: 'IN_STOCK',
      f: 0,
      ts: 0,
      th: '',
      lq: '',
    });
    const docs = [doc('linen-sofa'), doc('oak-bed')];
    const context = {
      manual: { trending: [], bestSeller: [], mostViewed: [] },
      snapshot,
    };

    const mostViewed = resolveRanking('mostViewed', docs, context);
    expect(mostViewed.basis).toBe('measured');
    // A measured ordering carries the day it was measured to, and drops the "(curated)" caveat.
    expect(mostViewed.asOf).toBe(YESTERDAY);
    expect(sortOptionLabel(mostViewed)).toBe('Most Viewed');
    expect(sortOptionLabel({ key: 'mostViewed', basis: 'manual' })).toBe('Most Viewed (curated)');

    const trending = resolveRanking('trending', docs, context);
    expect(trending.basis).toBe('measured');
  });
});

describe('the Worker entry', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/worker.ts', import.meta.url)),
    'utf8',
  );

  it('leaves the request path exactly as the adapter defines it', () => {
    /*
     * The one thing this file must not do is wrap, filter or re-implement `fetch`. The adapter's own
     * entrypoint is `{ fetch: handle }`; ours has to be that plus `scheduled`, so that adding a cron
     * cannot change how a single request is served.
     */
    expect(source).toContain("import { handle } from '@astrojs/cloudflare/handler';");
    expect(source).toMatch(/export default \{\s*fetch: handle,\s*scheduled,\s*\};/);
  });

  it('never lets a failed run throw out of the scheduled handler', () => {
    expect(source).toContain('logServerError');
    expect(source).toContain('waitUntil');
  });

  it('is the configured entry, with a nightly trigger on production and none on preview', () => {
    const wrangler = readFileSync(
      fileURLToPath(new URL('../../wrangler.toml', import.meta.url)),
      'utf8',
    );
    expect(wrangler).toContain('main = "./src/worker.ts"');
    expect(wrangler).toMatch(/\[triggers\]\ncrons = \["30 19 \* \* \*"\]/);
    // Inheritable key: without the empty override the preview Worker would write too.
    expect(wrangler).toMatch(/\[env\.preview\.triggers\]\ncrons = \[\]/);
  });
});
