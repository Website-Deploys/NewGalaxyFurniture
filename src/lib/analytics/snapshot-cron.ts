/**
 * The nightly snapshot run: read D1, write one file, commit with `[skip ci]`.
 *
 * It reuses, rather than reimplements, every piece it needs:
 *
 * - `measuredViewCounts` — the same query the admin Analytics view reads Most Viewed from, called
 *   over two ranges. No new SQL exists for the cron, so the numbers on the site and the numbers in
 *   the admin cannot disagree.
 * - `GitHubContentClient` — the same write pipeline every admin action uses, which means the write
 *   passes through `resolveContentPath` (the path allowlist), the same conflict handling, the same
 *   `REPOSITORY_UNAVAILABLE` mapping, and the same commit-message format with its audit trailers.
 *
 * It calls `client.writeFile` rather than `writeContentRecord`, for two reasons that both point the
 * same way. `writeContentRecord` merges the new record *over* the stored bytes — which is right for a
 * product patch and wrong here, because a merged snapshot would keep the view count of every product
 * ever measured, including ones since removed from the catalogue, forever. And its `actor` is the
 * branded `InteractiveActor`, which a scheduled path cannot obtain by design. Both layers below it —
 * the client, the allowlist, the message renderer — are the shared ones.
 * - `[skip ci]` — from the existing `buildCommitMessage`, because a snapshot changes a sort's
 *   *input* and the next build picks it up. Triggering a deploy for it would spend a production
 *   build every night for data that is not yet on any page.
 *
 * **What it deliberately cannot do.** The commit is attributed to an `AutomatedActor`, which is a
 * different type from the branded `InteractiveActor` that `applyTransition` demands. So this path can
 * write the snapshot and *cannot* publish, unpublish, or transition anything, and that is enforced by
 * the compiler rather than by this comment (Requirement 14.10).
 *
 * **Failure is silent to visitors and loud in the log.** Nothing user-facing depends on the snapshot:
 * a failed run leaves yesterday's file in place, or no file at all, and both sorts stay honest. So the
 * runner never throws out of `scheduled` — a thrown error there is a red mark on a schedule with no
 * consumer — and it records the reason through `logServerError`.
 *
 * Design: Conversion → Analytics.
 * Requirements: 3.14, 3.15, 20.11, 14.10, 25.14.
 */

import type { D1Database } from '@cloudflare/workers-types';

import { measuredViewCounts } from './queries';
import {
  buildAnalyticsSnapshot,
  serializeSnapshot,
  snapshotNumbersUnchanged,
  snapshotRanges,
  SNAPSHOT_PATH,
} from './snapshot';
import { logServerError } from '@/lib/errors';
import { buildCommitMessage } from '@/lib/github/commit-message';
import type { GitHubContentClient } from '@/lib/github/client';
import type { AnalyticsSnapshot } from '@/lib/search/sort';

/** The actor recorded in the commit trailer. Named for a reader of `git log`. */
export const SNAPSHOT_ACTOR = { automated: 'nightly analytics snapshot' } as const;

export type SnapshotOutcome =
  /** Committed. `path` and `commitSha` are the write's own report. */
  | { kind: 'written'; commitSha: string; asOf: string; products: number }
  /** The numbers are identical to the stored snapshot, so no commit was made. */
  | { kind: 'unchanged'; asOf: string }
  /** Nothing has been measured yet. The sorts stay curated, which is correct. */
  | { kind: 'no-data'; asOf: string }
  /** The run failed. Detail is in the log, never in a response. */
  | { kind: 'failed'; reason: 'read' | 'write' };

export interface SnapshotRunInput {
  db: D1Database;
  client: GitHubContentClient;
  /** Injected so the ranges are testable; the handler passes the scheduled time. */
  now: Date;
}

/**
 * Parse a stored snapshot loosely.
 *
 * The comparison only needs the numbers, and a hand-edited or older-format file must not make the
 * run fail — the worst case is a redundant commit, which is strictly better than a cron that stops
 * working because somebody reformatted a file.
 */
function parseStored(value: unknown): AnalyticsSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const table = (entry: unknown): Record<string, number> | undefined => {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const out: Record<string, number> = {};
    for (const [key, count] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof count === 'number' && Number.isFinite(count)) out[key] = count;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  };
  const views = table(record.views);
  const velocity = table(record.velocity);
  if (views === undefined && velocity === undefined) return null;
  return {
    asOf: typeof record.asOf === 'string' ? record.asOf : '',
    ...(views === undefined ? {} : { views }),
    ...(velocity === undefined ? {} : { velocity }),
  };
}

export async function runAnalyticsSnapshot(input: SnapshotRunInput): Promise<SnapshotOutcome> {
  const ranges = snapshotRanges(input.now);

  let next: AnalyticsSnapshot | null;
  try {
    const [lifetime, recent] = await Promise.all([
      measuredViewCounts(input.db, ranges.lifetime),
      measuredViewCounts(input.db, ranges.velocity),
    ]);
    next = buildAnalyticsSnapshot({
      // The last complete day the numbers cover — which is what the UI dates the sort to.
      asOf: ranges.lifetime.to,
      views: lifetime.counts,
      velocity: recent.counts,
    });
  } catch (error) {
    logServerError('analytics-snapshot: could not read the rollups', error, {
      from: ranges.lifetime.from,
      to: ranges.lifetime.to,
    });
    return { kind: 'failed', reason: 'read' };
  }

  if (next === null) return { kind: 'no-data', asOf: ranges.lifetime.to };

  try {
    // `readJson` resolves the path through the allowlist too, so a bad path fails before the write.
    const stored = await input.client.readJson(SNAPSHOT_PATH);
    const previous = stored === null ? null : parseStored(stored.value);

    if (snapshotNumbersUnchanged(previous, next)) {
      return { kind: 'unchanged', asOf: next.asOf };
    }

    const result = await input.client.writeFile({
      path: SNAPSHOT_PATH,
      content: serializeSnapshot(next),
      ...(stored === null ? {} : { sha: stored.sha }),
      message: buildCommitMessage({
        scope: 'analytics',
        action: 'update',
        subject: { name: `view snapshot ${next.asOf}` },
        actor: SNAPSHOT_ACTOR,
        actionCode: 'SNAPSHOT',
        // The next build picks it up; this change puts nothing new on the live site by itself.
        skipCi: true,
      }),
    });

    return {
      kind: 'written',
      commitSha: result.commitSha,
      asOf: next.asOf,
      products: Object.keys(next.views ?? {}).length,
    };
  } catch (error) {
    logServerError('analytics-snapshot: could not commit the snapshot', error, {
      path: SNAPSHOT_PATH,
    });
    return { kind: 'failed', reason: 'write' };
  }
}
