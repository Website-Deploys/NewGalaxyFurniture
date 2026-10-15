/**
 * The Worker entry: the adapter's request handler, plus the one scheduled handler.
 *
 * ACTIVE on the Cloudflare target. `wrangler.toml`'s `main` points at this file and
 * `astro.config.mjs` selects the Cloudflare adapter under `DEPLOY_TARGET=cloudflare`, so this is the
 * Worker entry for a Cloudflare build. On the default Netlify target neither is in effect and this
 * module is not part of the build.
 *
 * **Why this file exists at all.** `@astrojs/cloudflare` ships its own entrypoint that exports
 * `{ fetch }` and nothing else, and a `scheduled` handler has to be exported from the Worker's entry
 * module — there is no configuration hook for adding one. The adapter's wrangler customiser reads
 * `main: config.main ?? '@astrojs/cloudflare/entrypoints/server'`, so naming a real source file here
 * is a supported override, not a workaround: the injected default is used only when `main` is unset.
 * `handle` is the adapter's exported request handler (`@astrojs/cloudflare/handler`), so the request
 * path is byte-identical to the default entry — this file adds a handler beside it and changes
 * nothing about it.
 *
 * **The scheduled handler is deliberately thin.** It resolves the two things it needs (the D1
 * database and a GitHub client) and hands off; everything else is in `runAnalyticsSnapshot`, which
 * is testable without a Worker. It never throws: nothing on the site depends on the snapshot
 * existing, so a failed run leaves a log line rather than a failing schedule.
 *
 * **One resolver, consistently.** `getD1` and `createGitHubClient` are both imported through
 * `@/lib/env` (directly and via the GitHub factory), which `astro.config.mjs` aliases to
 * `src/lib/env.cloudflare.ts` on the Cloudflare target. So the D1 database and the GitHub token come
 * from the SAME Cloudflare resolver — the Worker never reads a Netlify-resolved secret. This is the
 * fix for the earlier mixed-resolver risk: the scheduled snapshot's `GITHUB_TOKEN` is read from the
 * Worker `env` binding, not `process.env`.
 *
 * Design: Deployment; Conversion → Analytics.
 * Requirements: 3.14, 3.15, 20.11.
 */

import { handle } from '@astrojs/cloudflare/handler';

import { runAnalyticsSnapshot } from '@/lib/analytics/snapshot-cron';
import { getD1 } from '@/lib/env';
import { logServerError } from '@/lib/errors';
import { createGitHubClient } from '@/lib/github/factory';

/**
 * `ScheduledController` / `ExecutionContext` are typed structurally rather than imported from
 * `@cloudflare/workers-types`, because the values this file needs from them are two fields, and the
 * runtime's own types disagree between the `workers-types` major versions this project pins.
 */
interface ScheduledEvent {
  /** The moment the schedule fired, in epoch milliseconds. */
  scheduledTime: number;
  /** The cron expression that fired, so one handler can serve several schedules. */
  cron: string;
}

interface ExecutionContextLike {
  waitUntil: (promise: Promise<unknown>) => void;
}

function scheduled(
  event: ScheduledEvent,
  _env: unknown,
  context: ExecutionContextLike,
): void {
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
     * D1 binding and no `GITHUB_TOKEN`. That is not a failure worth a stack trace every night: it is
     * a deployment with no content repository to write to, and the correct behaviour is to record one
     * line and stop. `getD1` and `createGitHubClient` accept the `RuntimeCarrier` context parameter;
     * the scheduled path has no request context, so an empty carrier is passed.
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
