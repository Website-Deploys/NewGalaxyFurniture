/**
 * Turning a posted body into a validated batch.
 *
 * Small, and separate from the endpoint on purpose: this is the whole of the trust boundary for
 * `POST /api/events`, and it is the part worth exercising directly. The endpoint around it does
 * rate limiting, bot filtering and a D1 write; the decision about *what counts as a batch* is
 * here, where a test can hand it a hostile body without a Worker runtime.
 *
 * The accepted shape is `{ events: [...] }`. A bare top-level array is also accepted because
 * `sendBeacon` payloads from an older deployed page may still be in flight during a rollout —
 * and refusing them would silently drop a day of counts on every deploy. The wrapper is what new
 * pages send, and it leaves room for a schema version without breaking anything already out
 * there.
 *
 * Requirements: 20.1, 20.3.
 */

import { validateBatch, type ValidatedBatch } from './rollup';

/** How many entries the submitted body claimed to contain, for the drop-rate log. */
export interface IngestResult extends ValidatedBatch {
  submitted: number;
}

/**
 * Validate a posted body.
 *
 * Never throws, and never distinguishes "not a batch" from "a batch of nothing valid": both are
 * zero events, and a beacon cannot act on the difference.
 */
export function eventsFromBody(body: unknown, now: number = Date.now()): IngestResult {
  const raw = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null
      ? (body as { events?: unknown }).events
      : undefined;

  const submitted = Array.isArray(raw) ? raw.length : 0;
  return { ...validateBatch(raw, now), submitted };
}
