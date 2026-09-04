/**
 * POST /api/admin/logout
 *
 * Deletes the server-side record, then clears the cookie. That order matters: the
 * deletion is what invalidates the session, and the cookie clear is only a tidy-up
 * for the browser. A cookie value captured before logout is useless afterwards
 * because there is no record left for `readSession` to find (Requirement 10.6).
 *
 * Declared `{ kind: 'session' }` in `ADMIN_ROUTES`: a valid session and a matching
 * CSRF token, but no permission — every role may end its own session. The CSRF check
 * is not ceremony here; without it any page on the internet could log the operator
 * out mid-edit.
 *
 * Requirements: 10.6, 10.8, 25.4.
 */

import type { APIContext } from 'astro';

import { clearedSessionCookieValue, destroySession } from '@/lib/auth/session';
import { getKV } from '@/lib/env';
import { requireAdmin } from '@/lib/auth/guard';

export const prerender = false;

export async function POST(context: APIContext): Promise<Response> {
  const guard = await requireAdmin(context);
  if (!guard.ok) return guard.response;

  await destroySession(getKV(context, 'SESSIONS'), guard.session.id);

  return new Response(null, {
    status: 204,
    headers: {
      'set-cookie': clearedSessionCookieValue(),
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}
