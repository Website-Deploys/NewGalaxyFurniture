/**
 * GET /api/admin/session
 *
 * The admin client's bootstrap: who am I, what may I do, and what CSRF token do I
 * put on my writes.
 *
 * Delivering the token on a `GET` is safe precisely because the response is
 * `application/json` with `cache-control: no-store` and no CORS headers — a
 * cross-origin page cannot read it, and the same-origin admin app can. The token
 * itself lives in the KV session record, never in a readable cookie, so it is not
 * available to script on any other origin either.
 *
 * `permissions` is included so `AdminNav` can hide what the role cannot do without a
 * second round trip. It is presentation only: the server re-derives authority from
 * `ADMIN_ROUTES` on every request regardless of what the client believes
 * (Requirement 10.14).
 *
 * Requirements: 10.14, 10.17.
 */

import type { APIContext } from 'astro';

import { ERROR_CODES, errorResponse, jsonResponse } from '@/lib/errors';
import { findAdminUserById } from '@/lib/auth/users';
import { getD1 } from '@/lib/env';
import { permissionsOf } from '@/lib/auth/permissions';
import { requireAdmin } from '@/lib/auth/guard';

export const prerender = false;

export async function GET(context: APIContext): Promise<Response> {
  const guard = await requireAdmin(context);
  if (!guard.ok) return guard.response;

  const user = await findAdminUserById(getD1(context), guard.session.userId);
  if (user === null || user.status !== 'ACTIVE') {
    // The account was deleted or disabled while the session was live. Treat it as
    // unauthenticated rather than 500: the operator's next action is to sign in.
    return errorResponse(ERROR_CODES.UNAUTHENTICATED);
  }

  return jsonResponse({
    user: { id: user.id, email: user.email, role: user.role },
    csrfToken: guard.session.csrfToken,
    permissions: permissionsOf(user.role),
    expiresAt: guard.session.expiresAt,
  });
}
