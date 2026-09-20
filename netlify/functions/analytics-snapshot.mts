/**
 * Netlify Scheduled Function — the nightly analytics snapshot.
 *
 * This replaces the Cloudflare Worker `scheduled()` handler that previously lived in
 * `src/worker.ts`. The behaviour is identical and the core logic is unchanged: it reads the D1
 * (now Neon Postgres) daily rollups and commits `data/snapshots/analytics.json` to the content
 * repository with `[skip ci]`, so the next build serves fresh Most Viewed and Trending data
 * without an extra deploy (Requirements 3.14, 3.15, 20.11).
 *
 * **Schedule.** `config.schedule` is a standard cron expression. `30 19 * * *` is 19:30 UTC =
 * 01:00 IST — after the day it summarises has closed in UTC, in the quietest hour for the
 * audience this site actually has. Netlify invokes this function on that schedule with no HTTP
 * request; it is not routable from the web.
 *
 * **Storage access.** The function runs in the same Netlify Functions runtime as the app, so it
 * reaches Neon and GitHub through the very same `src/lib/env.ts` abstraction (`getD1`,
 * `createGitHubClient`) — there is no Worker env, no binding object, and nothing Cloudflare here.
 *
 * **It never throws.** Nothing on the site depends on the snapshot existing, so a failed or
 * unconfigured run (no `NETLIFY_DATABASE_URL`, no `GITHUB_TOKEN`) records one log line and returns.
 */

import type { Config } from '@netlify/functions';

import { getD1 } from '../../src/lib/env.ts';
import { createGitHubClient } from '../../src/lib/github/factory.ts';
import { runAnalyticsSnapshot } from '../../src/lib/analytics/snapshot-cron.ts';
import { logServerError } from '../../src/lib/errors.ts';

export default async function handler(): Promise<Response> {
  const now = new Date();
  try {
    const db = getD1({});
    const client = createGitHubClient({});
    const outcome = await runAnalyticsSnapshot({ db, client, now });
    if (outcome.kind !== 'failed') {
      console.log(
        `[analytics-snapshot] ${outcome.kind}` +
          ('asOf' in outcome ? ` as of ${outcome.asOf}` : '') +
          (outcome.kind === 'written'
            ? ` — ${String(outcome.products)} product(s), commit ${outcome.commitSha.slice(0, 8)}`
            : ''),
      );
    }
  } catch (error) {
    // A misconfigured or unavailable environment (no database URL, no GitHub token) is not worth a
    // stack trace every night — it is a deployment with nothing to write to. One line, then stop.
    logServerError('analytics-snapshot: the scheduled run could not start', error);
  }
  // Scheduled functions must return a Response; the body is never read.
  return new Response('ok');
}

export const config: Config = {
  schedule: '30 19 * * *',
};
