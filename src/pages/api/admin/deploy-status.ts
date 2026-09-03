/**
 * GET /api/admin/deploy-status
 *
 * `{ state, startedAt, commitSha }` for the latest build of the content branch.
 *
 * The reason this endpoint exists is Requirement 14.12: after a publish the operator must
 * be told the *actual* deployment outcome, never a success reported before the change is
 * live. `PublishPanel` polls this and resolves to "Live now" or "Publish committed but
 * the site build failed" — the two honest answers — rather than assuming the commit was
 * the end of the story.
 *
 * Nothing from the upstream response body is passed through. The Cloudflare API returns
 * account identifiers, script metadata, and error detail; only the three fields above are
 * emitted, and a failure becomes a stable code with the upstream status logged
 * server-side (Requirements 25.14, 26.6).
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

function normalizeState(value: unknown): DeployState {
  if (typeof value !== 'string') return 'unknown';
  const lowered = value.toLowerCase();
  if (lowered === 'success' || lowered === 'active' || lowered === 'deployed') return 'success';
  if (lowered === 'failure' || lowered === 'failed' || lowered === 'error') return 'failure';
  if (lowered === 'building' || lowered === 'running' || lowered === 'in_progress')
    return 'building';
  if (lowered === 'queued' || lowered === 'pending') return 'queued';
  return 'unknown';
}

interface DeploymentsResponse {
  result?: {
    deployments?: {
      created_on?: unknown;
      versions?: { version_id?: unknown }[];
      annotations?: Record<string, unknown>;
      // Workers Builds reports the build outcome here.
      status?: unknown;
      metadata?: { commit_hash?: unknown; status?: unknown };
    }[];
  };
}

export async function GET(context: APIContext): Promise<Response> {
  const guard = await requireAdmin(context, 'product.read');
  if (!guard.ok) return guard.response;

  const accountId = optionalConfig(context, 'CF_ACCOUNT_ID');
  const apiToken = optionalConfig(context, 'CF_API_TOKEN');
  const workerName = optionalConfig(context, 'CF_WORKER_NAME') ?? 'new-galaxy-furniture';

  if (accountId === undefined || apiToken === undefined) {
    // Explicitly not an error state for the publish flow: the commit still happened. The
    // UI shows "publish committed, deploy status unavailable" rather than a false failure.
    return errorResponse(ERROR_CODES.CONFIGURATION_INCOMPLETE, {
      message:
        'Deployment status is not available in this environment. The publish was committed; check the build in Cloudflare.',
    });
  }

  // An upstream service endpoint, not site configuration — see the note on
  // GITHUB_API_BASE and the lint rule's allowlist.
  const base = 'https://api.cloudflare.com/client/v4';
  const url = `${base}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/deployments`;

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

    const body = (await response.json()) as DeploymentsResponse;
    const latest = body.result?.deployments?.[0];
    const status: DeployStatus = {
      state: normalizeState(latest?.metadata?.status ?? latest?.status),
      startedAt: typeof latest?.created_on === 'string' ? latest.created_on : null,
      commitSha:
        typeof latest?.metadata?.commit_hash === 'string' ? latest.metadata.commit_hash : null,
    };
    return jsonResponse(status);
  } catch (error) {
    // A network failure to the deployments API. Logged, never echoed.
    logServerError('deploy-status: request failed', error);
    return errorResponse(ERROR_CODES.REPOSITORY_UNAVAILABLE, {
      message: 'Could not read the deployment status. The publish itself was committed.',
    });
  }
}
