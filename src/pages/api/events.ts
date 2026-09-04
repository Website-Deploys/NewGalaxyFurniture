/**
 * `POST /api/events` — the analytics write path.
 *
 * Everything about this endpoint is arranged so that the *most* it can be made to reveal is
 * "on this day, this many people did this to this product". The privacy guarantee is not a
 * policy applied to the data after it arrives; it is the absence of anywhere to put anything
 * else. `recordEvents` takes a batch and increments counters, and `migrations/0003_events.sql`
 * has no column for a visitor, a session, an address, or a timestamp finer than a day
 * (Requirement 20.2).
 *
 * Three consequences of being a beacon target rather than an API:
 *
 * - **It always answers 204, even when it stored nothing.** `sendBeacon` cannot read a
 *   response, cannot retry, and cannot report a failure; a 4xx here would be a status nobody
 *   observes, spent on telling a browser something it cannot act on. So a malformed batch is
 *   dropped, counted in the server log, and acknowledged. The exception is the rate limit,
 *   which answers 429 because a real client — the test suite, a monitoring probe — should be
 *   able to tell that it was throttled.
 * - **Invalid entries are dropped, not the whole batch.** `validateBatch` keeps the good
 *   nine out of ten; discarding all ten because one had a bad timestamp would lose more truth
 *   than it protects.
 * - **Obvious bots are dropped before the counters move.** A crawler's page views are not
 *   interest, and letting them in makes every figure on the Analytics screen a lie in the
 *   operator's favour — the exact failure Requirement 20.9 is about.
 *
 * Design: Conversion → Analytics.
 * Requirements: 20.1, 20.2, 20.3, 20.4, 25.8.
 */

import type { APIContext } from 'astro';

import { EVENTS_LIMIT_PER_MINUTE } from '@/lib/auth/rate-limit';
import { clientAddress } from '@/lib/auth/guard';
import { consumeBindingLimit } from '@/lib/auth/rate-limit';
import { ERROR_CODES, errorResponse, logServerError, minutesPhrase } from '@/lib/errors';
import { getD1, getWorkerEnv } from '@/lib/env';
import { eventsFromBody } from '@/lib/analytics/ingest';
import { isLikelyBot } from '@/lib/analytics/bots';
import { MAX_BATCH_EVENTS, recordEvents } from '@/lib/analytics/rollup';

export const prerender = false;

/**
 * The largest body worth reading: twenty events of a 120-character entity each, with slack.
 * A beacon that arrives larger than this is not a beacon from this site.
 */
const MAX_BODY_BYTES = 8 * 1024;

/** 204 with no body. The only success this endpoint has. */
function accepted(): Response {
  return new Response(null, {
    status: 204,
    headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
  });
}

export async function POST(context: APIContext): Promise<Response> {
  const declared = Number.parseInt(context.request.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return accepted();

  // 200 per minute per address (Requirement 20.4). The binding's period is 60 s, which is
  // exactly this row's window, so no KV counter is needed.
  let env: ReturnType<typeof getWorkerEnv> | null;
  try {
    env = getWorkerEnv(context);
  } catch {
    // No runtime means no counters to write to either; the read below will decide.
    env = null;
  }
  const address = clientAddress(context.request);
  const decision = await consumeBindingLimit(env?.RL_EVENTS, `events:${address}`);
  if (!decision.allowed) {
    return errorResponse(ERROR_CODES.RATE_LIMITED, {
      message: `Too many events. Try again in ${minutesPhrase(decision.retryAfterMinutes)}.`,
      headers: {
        'retry-after': '60',
        // States the ceiling so a client that is legitimately batching can slow down.
        'x-ratelimit-limit': String(EVENTS_LIMIT_PER_MINUTE),
      },
    });
  }

  // Bots are dropped here rather than filtered out of the reports later: a count that was
  // never recorded cannot be mistaken for interest.
  if (isLikelyBot(context.request.headers.get('user-agent'))) return accepted();

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return accepted();
  }

  const { events, rejected, submitted } = eventsFromBody(body);
  if (rejected > 0) {
    console.warn(
      `[events] dropped ${String(rejected)} of ${String(submitted)} submitted entries ` +
        `(ceiling ${String(MAX_BATCH_EVENTS)})`,
    );
  }
  if (events.length === 0) return accepted();

  try {
    await recordEvents(getD1(context), events);
  } catch (error) {
    // A failed rollup loses counts and nothing else. It must not become a visible error on a
    // page the visitor is reading, and the beacon could not surface one anyway.
    logServerError('events: rollup failed', error);
  }

  return accepted();
}

export function ALL(): Response {
  return errorResponse(ERROR_CODES.ROUTE_UNKNOWN, {
    message: 'Events are submitted with POST.',
    status: 405,
  });
}
