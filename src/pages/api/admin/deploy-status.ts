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
 * It reads the **Netlify** deploys API. Credentials are optional: without `NETLIFY_API_TOKEN` and
 * `NETLIFY_SITE_ID` the endpoint returns a stable `CONFIGURATION_INCOMPLETE`, and the app does not
 * depend on them to run normally. Nothing from the upstream body is passed through beyond the three
 * fields above; a failure becomes a stable code with the upstream status logged server-side
 * (Requirements 25.14, 26.6).
 *
 * Requirements: 14.12, 14.13, 25.14, 26.6.
 */

import type { APIContext } from 'astro';

import { ERROR_CODES, errorResponse, jsonResponse, logServerError } from '@/lib/errors';
import { optionalConfig } from '@/lib/env';
import { requireAdmin } from '@/lib/auth/guard';

export const prerender = false;

/** The four states the admin UI distinguishes. Anything unrecognised is `unknown`. */
export type DeployState = 'queued' | 'building' | 'success' | 'failure' | 'unknown';

export interface DeployStatus {
  state: DeployState;
  startedAt: string | null;
  commitSha: string | null;
}

/** Map Netlify's deploy `state` to the four states the UI distinguishes. */
function normalizeState(value: unknown): DeployState {
  if (typeof value !== 'string') return 'unknown';
  const lowered = value.toLowerCase();
  if (lowered === 'ready' || lowered === 'current') return 'success';
  if (lowered === 'error' || lowered === 'failed') return 'failure';
  if (
    lowered === 'building' ||
    lowered === 'processing' ||
    lowered === 'uploading' ||
    lowered === 'preparing'
  )
    return 'building';
  if (lowered === 'new' || lowered === 'pending' || lowered === 'enqueued') return 'queued';
  return 'unknown';
}

interface NetlifyDeploy {
  state?: unknown;
  created_at?: unknown;
  commit_ref?: unknown;
}

export async function GET(context: APIContext): Promise<Response> {
  const guard = await requireAdmin(context, 'product.read');
  if (!guard.ok) return guard.response;

  const apiToken = optionalConfig(context, 'NETLIFY_API_TOKEN');
  const siteId = optionalConfig(context, 'NETLIFY_SITE_ID');

  if (apiToken === undefined || siteId === undefined) {
    // Explicitly not an error state for the publish flow: the commit still happened. The UI shows
    // "publish committed, deploy status unavailable" rather than a false failure.
    return errorResponse(ERROR_CODES.CONFIGURATION_INCOMPLETE, {
      message:
        'Deployment status is not available in this environment. The publish was committed; check the build in Netlify.',
    });
  }

  // The Netlify API — an upstream service endpoint, not site configuration.
  const url = `https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/deploys?per_page=1`;

  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${apiToken}`, accept: 'application/json' },
    });
    if (!response.ok) {
      console.error(`[deploy-status] upstream returned ${response.status}`);
      return errorResponse(ERROR_CODES.REPOSITORY_UNAVAILABLE, {
        message: 'Could not read the deployment status. The publish itself was committed.',
      });
    }

    const body = (await response.json()) as NetlifyDeploy[];
    const latest = Array.isArray(body) ? body[0] : undefined;
    const status: DeployStatus = {
      state: normalizeState(latest?.state),
      startedAt: typeof latest?.created_at === 'string' ? latest.created_at : null,
      commitSha: typeof latest?.commit_ref === 'string' ? latest.commit_ref : null,
    };
    return jsonResponse(status);
  } catch (error) {
    // A network failure to the deploys API. Logged, never echoed.
    logServerError('deploy-status: request failed', error);
    return errorResponse(ERROR_CODES.REPOSITORY_UNAVAILABLE, {
      message: 'Could not read the deployment status. The publish itself was committed.',
    });
  }
}
