/**
 * The optional analytics snapshot behind the Most Viewed and Trending sorts.
 *
 * `data/snapshots/analytics.json` is written by the nightly scheduled handler in `src/worker.ts`,
 * which commits it with `[skip ci]` — so the *next* build picks it up and no deploy is spent on the
 * snapshot itself. Until the first night with recorded views, the file does not exist and both sorts
 * fall back to the operator's curated ordering and are labelled as curated. That is the designed
 * behaviour, not a degraded one, and it is also the state of a fresh preview environment (which has
 * no schedule of its own, deliberately).
 *
 * It is loaded with `import.meta.glob` rather than a static import precisely because the file is
 * absent: a static `import '…/analytics.json'` fails the build when the file is missing, and a
 * `try { await import(…) }` fails at bundle time for the same reason. A glob that matches nothing
 * returns `{}`. So dropping the snapshot in is a **file drop with no code change** — exactly the
 * property the logo swap and the category files already have.
 *
 * A malformed snapshot is ignored rather than fatal: a bad analytics export must not take the
 * catalogue down, and "curated" is always a truthful fallback.
 *
 * Requirements: 3.14, 3.15, 20.11.
 */

import type { AnalyticsSnapshot } from '@/lib/search/sort';

const modules = import.meta.glob<{ default: unknown }>('../../../data/snapshots/analytics.json', {
  eager: true,
});

function toNumberTable(value: unknown): Readonly<Record<string, number>> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function parseSnapshot(raw: unknown): AnalyticsSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const asOf = record.asOf;
  if (typeof asOf !== 'string' || asOf.trim() === '') return null;

  const views = toNumberTable(record.views);
  const velocity = toNumberTable(record.velocity);
  // A snapshot with a date but no numbers measures nothing; treating it as measured would put a
  // date next to an ordering that is really the curated one.
  if (views === undefined && velocity === undefined) return null;

  return {
    asOf,
    ...(views === undefined ? {} : { views }),
    ...(velocity === undefined ? {} : { velocity }),
  };
}

const snapshot: AnalyticsSnapshot | null = (() => {
  const first = Object.values(modules)[0];
  return first === undefined ? null : parseSnapshot(first.default);
})();

/** `null` until a valid snapshot exists — which is the state at launch. */
export function getAnalyticsSnapshot(): AnalyticsSnapshot | null {
  return snapshot;
}
