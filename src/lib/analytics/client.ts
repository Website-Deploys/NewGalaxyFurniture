/**
 * The client-side event batcher.
 *
 * The whole module is written to be *droppable*. It runs on a marketing page whose job is to
 * sell furniture, so every failure mode — no `sendBeacon`, a blocked request, a browser that
 * closes mid-flush — resolves to "the count is lower than reality", which is the limitation
 * the admin Analytics screen already states out loud. Nothing here throws into the page, and
 * nothing here awaits anything the visitor is waiting for.
 *
 * Why the flush policy is exactly the design's:
 *
 * - **`visibilitychange` to `hidden`, not `unload`.** `unload` and `beforeunload` are not
 *   fired reliably on mobile Safari or on any browser that restores a page from the
 *   back/forward cache, and registering them *disqualifies* the page from that cache. The
 *   visibility transition is the only event that fires on every path out of a page.
 * - **`sendBeacon`, not `fetch`.** A beacon is queued by the browser and survives the
 *   document; a `fetch` from a page being torn down is cancelled. `keepalive: true` is the
 *   documented fallback and is used only when `sendBeacon` is absent.
 * - **Five events, then flush.** Small enough that a visitor who reads one page and leaves
 *   has usually already been counted, and far enough under the server's twenty-event ceiling
 *   that a coincidental double flush cannot exceed it.
 *
 * The queue holds no identifier of any kind, and this module creates none: there is no id to
 * generate, no cookie to read, and no storage to write. The counterpart of that on the server
 * is that there is no column for one.
 *
 * Design: Conversion → Analytics.
 * Requirements: 20.1, 20.2, 20.3.
 */

import { ANALYTICS_EVENT_TYPES, type AnalyticsEvent, type AnalyticsEventType } from './rollup';

export { ANALYTICS_EVENT_TYPES };
export type { AnalyticsEvent, AnalyticsEventType };

/** Where a batch is posted. */
export const EVENTS_ENDPOINT = '/api/events';

/** Flush once the queue reaches this many events. */
export const FLUSH_AT = 5;

/** The server truncates above this; the client never sends more. */
export const MAX_BATCH = 20;

/** Entity strings are bounded here as well as on the server, to keep beacons small. */
export const MAX_ENTITY = 120;

/** Just enough of the platform to be injectable in a test. */
export interface BeaconTransport {
  /** Returns false when the browser refused to queue the beacon. */
  send(url: string, body: string): boolean;
}

export interface BatcherOptions {
  transport: BeaconTransport;
  endpoint?: string;
  flushAt?: number;
  now?: () => number;
}

export interface EventBatcher {
  /** Queue one event. Flushes when the queue reaches `flushAt`. */
  track(type: AnalyticsEventType, entity?: string, results?: number): void;
  /** Send whatever is queued. Returns the number of events handed to the transport. */
  flush(): number;
  /** Queue length, for tests and for the dev-mode assertions. */
  size(): number;
}

function isEventType(value: string): value is AnalyticsEventType {
  return (ANALYTICS_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Create a batcher.
 *
 * Pure with respect to the platform: it takes a transport and a clock, so the batching and
 * flushing rules are unit-testable in Node with no DOM at all. The browser wiring lives in
 * `install()` below and is the only part that touches globals.
 */
export function createBatcher(options: BatcherOptions): EventBatcher {
  const endpoint = options.endpoint ?? EVENTS_ENDPOINT;
  const flushAt = options.flushAt ?? FLUSH_AT;
  const now = options.now ?? (() => Date.now());
  let queue: AnalyticsEvent[] = [];

  function flush(): number {
    if (queue.length === 0) return 0;
    const batch = queue.slice(0, MAX_BATCH);
    const remainder = queue.slice(MAX_BATCH);
    // The queue is cleared *before* the send, not after. A transport that throws or refuses
    // must not leave the same events queued to be re-sent on the next flush, which would
    // double-count them — an undercount is documented behaviour, an overcount is a lie.
    queue = remainder;
    try {
      options.transport.send(endpoint, JSON.stringify({ events: batch }));
    } catch {
      // A refused beacon is a lost count and nothing more.
    }
    return batch.length;
  }

  return {
    track(type, entity, results) {
      if (!isEventType(type)) return;
      const event: AnalyticsEvent = { t: type, ts: now() };
      if (typeof entity === 'string' && entity !== '') event.e = entity.slice(0, MAX_ENTITY);
      if (typeof results === 'number' && Number.isFinite(results) && results >= 0) {
        event.r = Math.floor(results);
      }
      queue.push(event);
      if (queue.length >= flushAt) flush();
    },
    flush,
    size: () => queue.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Browser wiring                                                             */
/* -------------------------------------------------------------------------- */

/** `navigator.sendBeacon`, with the documented `fetch` fallback. */
export function browserTransport(): BeaconTransport {
  return {
    send(url, body) {
      const blob = new Blob([body], { type: 'application/json' });
      if (typeof navigator.sendBeacon === 'function') return navigator.sendBeacon(url, blob);
      void fetch(url, { method: 'POST', body: blob, keepalive: true }).catch(() => undefined);
      return true;
    },
  };
}

let installed: EventBatcher | null = null;

/**
 * Install the page's single batcher and its flush triggers.
 *
 * Idempotent: a second call returns the existing batcher rather than adding a second set of
 * listeners, because two batchers on one page would double every count.
 */
export function install(): EventBatcher {
  if (installed !== null) return installed;
  const batcher = createBatcher({ transport: browserTransport() });
  installed = batcher;

  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.visibilityState === 'hidden') batcher.flush();
    },
    // Passive: this listener must never be able to delay a navigation.
    { passive: true },
  );

  // `pagehide` covers the one case `visibilitychange` misses in some older WebKit builds:
  // a same-tab navigation that never transitions to hidden first.
  window.addEventListener('pagehide', () => batcher.flush(), { passive: true });

  return batcher;
}

/** The installed batcher, or null before `install()`. */
export function current(): EventBatcher | null {
  return installed;
}

/** Test seam: forget the installed batcher. Never called by application code. */
export function reset(): void {
  installed = null;
}
