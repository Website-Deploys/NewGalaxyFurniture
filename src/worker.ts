/**
 * The Worker entry: the adapter's request handler, plus the one scheduled handler.
 *
 * **Why this file exists at all.** `@astrojs/cloudflare` ships its own entrypoint that exports
 * `{ fetch }` and nothing else, and a `scheduled` handler has to be exported from the Worker's
 * entry module — there is no configuration hook for adding one. The adapter's own wrangler
 * customiser reads `main: config.main ?? '@astrojs/cloudflare/entrypoints/server'`, so naming a real
 * source file here is a supported override rather than a workaround: the injected default is used
 * only when `main` is unset. `handle` is the adapter's exported request handler
 * (`@astrojs/cloudflare/handler`), so the request path is *byte-identical* to the default entry —
 * this file adds a handler beside it and changes nothing about it.
 *
 * The earlier reason `main` was left unset — that pointing it at a build artifact fails the vite
 * plugin's existence check on a clean tree — does not apply to a source file, which is always there.
 *
 * **The scheduled handler is deliberately thin.** It resolves the two bindings it needs and hands
 * off; everything else is in `runAnalyticsSnapshot`, which is testable without a Worker. It never
 * throws: nothing on the site depends on the snapshot existing, so a failed run must leave a log
 * line rather than a failing schedule.
 *
 * Design: Deployment; Conversion → Analytics.
 * Requirements: 3.14, 3.15, 20.11.
 */

import { handle } from '@astrojs/cloudflare/handler';

import { runAnalyticsSnapshot } from '@/lib/analytics/snapshot-cron';
import { logServerError } from '@/lib/errors';
import { getD1 } from '@/lib/env';
import { createGitHubClient } from '@/lib/github/factory';

/**
 * The scheduled export.
 *
 * `ScheduledController`/`ExecutionContext` are typed structurally rather than imported from
 * `@cloudflare/workers-types`, because the values this file needs from them are two fields, and the
 * runtime's own types disagree between the `workers-types` major versions this project pins.
 */
interface ScheduledEvent {
  /** The moment the schedule fired, in epoch milliseconds. */
  scheduledTime: number;
  /** The cron expression that fired, so one handler can serve several schedules. */
  cron: string;
}

interface Context {
  waitUntil: (promise: Promise<unknown>) => void;
}

function scheduled(event: ScheduledEvent, _env: unknown, context: Context): void {
  /*
   * `waitUntil` rather than awaiting inline: the platform gives a scheduled invocation its own
   * lifetime, and registering the work is what keeps the runtime waiting for the commit instead of
   * tearing the invocation down mid-flight. The handler itself therefore returns nothing to await.
   */
  context.waitUntil(runSnapshot(new Date(event.scheduledTime)));
}

async function runSnapshot(now: Date): Promise<void> {
  try {
    /*
     * Both accessors throw when the environment is not configured — a preview or a local run with no
     * D1 id and no `GITHUB_TOKEN`. That is not a failure worth a stack trace every night: it is a
     * deployment that has no content repository to write to, and the correct behaviour is to record
     * one line and stop.
     */
    const db = getD1({});
    const client = createGitHubClient({});
    const outcome = await runAnalyticsSnapshot({ db, client, now });
    if (outcome.kind === 'failed') return; // already logged, with detail
    console.log(
      `[analytics-snapshot] ${outcome.kind}` +
        ('asOf' in outcome ? ` as of ${outcome.asOf}` : '') +
        (outcome.kind === 'written'
          ? ` — ${String(outcome.products)} product(s), commit ${outcome.commitSha.slice(0, 8)}`
          : ''),
    );
  } catch (error) {
    logServerError('analytics-snapshot: the scheduled run could not start', error);
  }
}

export default {
  fetch: handle,
  scheduled,
};
