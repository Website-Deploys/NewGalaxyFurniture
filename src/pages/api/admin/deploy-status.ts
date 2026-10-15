/**
 * GET /api/admin/deploy-status
 *
 * `{ state, startedAt, commitSha }` for the latest deploy of the site.
 *
 * The reason this endpoint exists is Requirement 14.12: after a publish the operator must be told
 * the *actual* deployment outcome, never a success reported before the change is live.
 * `PublishPanel` polls this and resolves to "Live now" or "Publish committed but the site build
 * failed" — the two honest answers — rather than assuming the commit was the end of the story.
 *
 * **Platform-aware, credentials optional.** The endpoint supports both deployment targets and reads
 * whichever the environment is configured for:
 *   - Cloudflare: the Workers *deployments* API, keyed by `CF_ACCOUNT_ID` + `CF_API_TOKEN` and the
 *     script name (`CF_WORKER_NAME`, defaulting to the wrangler `name`).
 *   - Netlify: the deploys API, keyed by `NETLIFY_API_TOKEN` + `NETLIFY_SITE_ID`.
 * Every credential is OPTIONAL. When neither set is present — the local-development case — the
 * endpoint returns a stable `CONFIGURATION_INCOMPLETE`; it never fabricates a deploy state and
 * requires no secret to run. Nothing from an upstream body is passed through beyond the three fields
 * above; a failure becomes a stable code with the upstream status logged server-side
 * (Requirements 25.14, 26.6).
 *
 * Requirements: 14.12, 14.13, 25.14, 26.6.
 */

import type { APIContext } from 'astro';

import { ERROR_CODES, errorResponse, jsonResponse, logServerError } from '@/lib/errors';
import { optionalConfig } from '@/lib/env';
import { requireAdmin } from '@/lib/auth/guard';

export const prerender = false;

/** The states the admin UI distinguishes. Anything unrecognised is `unknown`. */
export type DeployState = 'queued' | 'building' | 'success' | 'failure' | 'unknown';

export interface DeployStatus {
  state: DeployState;
  startedAt: string | null;
  commitSha: string | null;
}

/** Map a provider's deploy/deployment `state` string to the states the UI distinguishes. */
function normalizeState(value: unknown): DeployState {
  if (typeof value !== 'string') return 'unknown';
  const lowered = value.toLowerCase();
  // Netlify: ready|current → success; Cloudflare deployments are recorded already-complete, which
  // reads as success too. Both providers' "live" vocabulary maps here.
  if (lowered === 'ready' || lowered === 'current' || lowered === 'active' || lowered === 'success')
    return 'success';
  if (lowered === 'error' || lowered === 'failed' || lowered === 'failure') return 'failure';
  if (
    lowered === 'building' ||
    lowered === 'processing' ||
    lowered === 'uploading' ||
    lowered === 'preparing'
  )
    return 'building';
  if (lowered === 'new' || lowered === 'pending' || lowered === 'enqueued' || lowered === 'queued')
    return 'queued';
  return 'unknown';
}

const UPSTREAM_UNAVAILABLE =
  'Could not read the deployment status. The publish itself was committed.';

/* -------------------------------------------------------------------------- */
/* Cloudflare: Workers deployments API                                        */
/* -------------------------------------------------------------------------- */

interface CfDeployment {
  created_on?: unknown;
  /** The deployment's source annotation; the commit hash lives here when wrangler sets it. */
  annotations?: { 'workers/triggered_by'?: unknown } & Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Read the latest Worker deployment. Cloudflare records a deployment only once it is live, so a
 * returned row is reported as `success`; the absence of a build/queue state is a property of the
 * platform, not a gap here. The commit hash is not a first-class field on a Workers deployment, so
 * `commitSha` is surfaced only when wrangler recorded one in the deployment metadata, and is `null`
 * otherwise rather than guessed.
 */
async function readCloudflareStatus(
  accountId: string,
  apiToken: string,
  scriptName: string,
): Promise<DeployStatus | null> {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/workers/scripts/${encodeURIComponent(scriptName)}/deployments`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${apiToken}`, accept: 'application/json' },
  });
  if (!response.ok) {
    console.error(`[deploy-status] cloudflare upstream returned ${response.status}`);
    return null;
  }
  const body = (await response.json()) as {
    result?: { deployments?: CfDeployment[] };
  };
  const latest = body.result?.deployments?.[0];
  if (latest === undefined) {
    // The account/script is reachable but has no deployments yet.
    return { state: 'unknown', startedAt: null, commitSha: null };
  }
  const commit = latest.metadata?.['commit_hash'];
  return {
    // A recorded Workers deployment is live by definition.
    state: 'success',
    startedAt: typeof latest.created_on === 'string' ? latest.created_on : null,
    commitSha: typeof commit === 'string' ? commit : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Netlify: deploys API                                                       */
/* -------------------------------------------------------------------------- */

interface NetlifyDeploy {
  state?: unknown;
  created_at?: unknown;
  commit_ref?: unknown;
}

async function readNetlifyStatus(apiToken: string, siteId: string): Promise<DeployStatus | null> {
  // The Netlify API — an upstream service endpoint, not site configuration.
  const url = `https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/deploys?per_page=1`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${apiToken}`, accept: 'application/json' },
  });
  if (!response.ok) {
    console.error(`[deploy-status] netlify upstream returned ${response.status}`);
    return null;
  }
  const body = (await response.json()) as NetlifyDeploy[];
  const latest = Array.isArray(body) ? body[0] : undefined;
  return {
    state: normalizeState(latest?.state),
    startedAt: typeof latest?.created_at === 'string' ? latest.created_at : null,
    commitSha: typeof latest?.commit_ref === 'string' ? latest.commit_ref : null,
  };
}

/* -------------------------------------------------------------------------- */

export async function GET(context: APIContext): Promise<Response> {
  const guard = await requireAdmin(context, 'product.read');
  if (!guard.ok) return guard.response;

  // Cloudflare first: if its read credentials are present, this environment is a Worker deployment.
  const cfAccountId = optionalConfig(context, 'CF_ACCOUNT_ID');
  const cfApiToken = optionalConfig(context, 'CF_API_TOKEN');
  // Default the polled script name to the wrangler `name` for this project.
  const cfScriptName = optionalConfig(context, 'CF_WORKER_NAME') ?? 'new-galaxy-furniture';

  // Netlify next.
  const netlifyApiToken = optionalConfig(context, 'NETLIFY_API_TOKEN');
  const netlifySiteId = optionalConfig(context, 'NETLIFY_SITE_ID');

  const configured =
    (cfAccountId !== undefined && cfApiToken !== undefined) ||
    (netlifyApiToken !== undefined && netlifySiteId !== undefined);

  if (!configured) {
    // Explicitly not an error state for the publish flow: the commit still happened. The UI shows
    // "publish committed, deploy status unavailable" rather than a false failure. This is also the
    // honest answer in local development, where no deploy credentials are set.
    return errorResponse(ERROR_CODES.CONFIGURATION_INCOMPLETE, {
      message:
        'Deployment status is not available in this environment. The publish was committed; check the build in your hosting dashboard.',
    });
  }

  try {
    const status =
      cfAccountId !== undefined && cfApiToken !== undefined
        ? await readCloudflareStatus(cfAccountId, cfApiToken, cfScriptName)
        : await readNetlifyStatus(
            // Both are defined here: `configured` guaranteed one full pair, and the CF pair was not it.
            netlifyApiToken as string,
            netlifySiteId as string,
          );

    if (status === null) {
      return errorResponse(ERROR_CODES.REPOSITORY_UNAVAILABLE, { message: UPSTREAM_UNAVAILABLE });
    }
    return jsonResponse(status);
  } catch (error) {
    // A network failure to the provider API. Logged, never echoed.
    logServerError('deploy-status: request failed', error);
    return errorResponse(ERROR_CODES.REPOSITORY_UNAVAILABLE, { message: UPSTREAM_UNAVAILABLE });
  }
}
