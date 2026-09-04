/**
 * The per-request plumbing every admin product endpoint needs, assembled once.
 *
 * Each endpoint would otherwise repeat six steps — guard, look up the acting user, mint the
 * interactive-actor witness, read two bindings, build the GitHub client, and map a
 * configuration failure to a stable code — and repetition in that particular sequence is
 * how one endpoint ends up missing one of them.
 *
 * The witness is the load-bearing part. `interactiveActor` can only be built from a live
 * `Session` plus the email from the `admin_users` row, and `applyTransition` will not
 * accept anything else, so publication is reachable only from an authenticated browser
 * request (Requirement 14.10). The email comes from D1, never from the request, because it
 * is written into the commit trailer as an audit record (Requirement 17.12).
 *
 * Requirements: 10.1, 10.14, 14.10, 17.2, 17.12, 25.12.
 */

import type { APIContext } from 'astro';
import type { KVNamespace } from '@cloudflare/workers-types';

import { ERROR_CODES, errorResponse } from '../errors';
import { createGitHubClient } from '../github/factory';
import { findAdminUserById } from '../auth/users';
import { getD1, getKV } from '../env';
import { interactiveActor, type InteractiveActor } from '../auth/actor';
import { requireAdmin } from '../auth/guard';
import type { GitHubContentClient } from '../github/client';
import type { Permission } from '../auth/permissions';
import type { Session } from '../auth/session';
import { logServerError } from '@/lib/errors';

export interface AdminContext {
  session: Session;
  actor: InteractiveActor;
  /** KV `DRAFTS`: draft working copies and the product index. */
  drafts: KVNamespace;
  client: GitHubContentClient;
}

export type AdminContextResult =
  { ok: true; context: AdminContext } | { ok: false; response: Response };

/**
 * Guard, then assemble.
 *
 * A missing binding or an unconfigured repository is reported as
 * `CONFIGURATION_INCOMPLETE`, not as an internal error: the operator can act on "this
 * environment is not configured", and the detail is in the logs.
 */
export async function openAdminContext(
  apiContext: APIContext,
  permission: Permission,
): Promise<AdminContextResult> {
  const guard = await requireAdmin(apiContext, permission);
  if (!guard.ok) return { ok: false, response: guard.response };

  let drafts: KVNamespace;
  let client: GitHubContentClient;
  let email: string;
  try {
    drafts = getKV(apiContext, 'DRAFTS');
    const user = await findAdminUserById(getD1(apiContext), guard.session.userId);
    if (user === null || user.status !== 'ACTIVE') {
      // Deleted or disabled mid-session. The next action is to sign in again.
      return { ok: false, response: errorResponse(ERROR_CODES.UNAUTHENTICATED) };
    }
    email = user.email;
    client = createGitHubClient(apiContext);
  } catch (error) {
    logServerError('admin: could not assemble the request context', error);
    return { ok: false, response: errorResponse(ERROR_CODES.CONFIGURATION_INCOMPLETE) };
  }

  return {
    ok: true,
    context: {
      session: guard.session,
      actor: interactiveActor(guard.session, email),
      drafts,
      client,
    },
  };
}

/**
 * Where the write lock lives, keyed `lock:product:{id}`.
 *
 * `RATELIMIT`, as `wrangler.toml` declares ("plus the short write locks"), and
 * deliberately not `DRAFTS`: a lock is transient coordination state, and keeping it out of
 * `DRAFTS` means the draft store's key listing never walks lock keys and can never
 * mistake one for content.
 */
export function lockNamespace(apiContext: APIContext): KVNamespace {
  return getKV(apiContext, 'RATELIMIT');
}
