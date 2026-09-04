/**
 * `GET /api/admin/leads/:id/image` — the quarantined enquiry attachment.
 *
 * This is the only route in the codebase that reads an object under `quarantine/`, and it exists
 * so Requirement 6.11's "visible only within the leads admin" can be satisfied by *showing* the
 * image rather than by naming its key and asking the operator to imagine it. A customer who sends
 * a photograph of the corner their sofa has to fit has said something the operator needs to see.
 *
 * Four things confine it:
 *
 * 1. **`requireAdmin(context, 'lead.read')`** — a session, an origin match, and the declared
 *    permission from `ADMIN_ROUTES`. There is no unauthenticated path to this handler.
 * 2. **The key is read from the lead row**, never from the request. The URL carries a lead id;
 *    the object key comes out of D1. So there is no traversal to attempt — an attacker who
 *    controls the whole URL still cannot name an object.
 * 3. **The key is re-checked against the quarantine prefix** before the read. Belt and braces: if
 *    a future write path ever put a `products/**` key on a lead row, this route would refuse it
 *    rather than becoming a second, unbudgeted image delivery route.
 * 4. **`Cache-Control: private, no-store`** and `X-Robots-Tag`. The response must not be held by
 *    a shared cache or an intermediary; it is personal data belonging to whoever sent it.
 *
 * `Content-Disposition: inline` with a fixed, server-generated filename: the visitor's own
 * filename is never echoed, so a crafted name cannot reach a header.
 *
 * Requirements: 6.11, 25.5, 25.7.
 */

import type { APIContext } from 'astro';

import { ERROR_CODES, errorResponse, logServerError, toClientErrorResponse } from '@/lib/errors';
import { getLead } from '@/lib/leads/store';
import { getD1, getR2 } from '@/lib/env';
import { isQuarantinedKey } from '@/lib/leads/image';
import { requireAdmin } from '@/lib/auth/guard';

export const prerender = false;

export async function GET(context: APIContext): Promise<Response> {
  const guard = await requireAdmin(context, 'lead.read');
  if (!guard.ok) return guard.response;

  const id = context.params.id;
  if (typeof id !== 'string' || id === '') return errorResponse(ERROR_CODES.NOT_FOUND);

  try {
    const lead = await getLead(getD1(context), id);
    if (lead === null || lead.imageKey === null) return errorResponse(ERROR_CODES.NOT_FOUND);
    if (!isQuarantinedKey(lead.imageKey)) {
      console.error('[leads] refused a non-quarantined image key on lead', id);
      return errorResponse(ERROR_CODES.NOT_FOUND);
    }

    const object = await getR2(context).get(lead.imageKey);
    if (object === null) return errorResponse(ERROR_CODES.NOT_FOUND);

    const contentType = object.httpMetadata?.contentType ?? 'application/octet-stream';
    const extension = contentType === 'image/jpeg' ? 'jpg' : 'webp';
    return new Response(await object.arrayBuffer(), {
      headers: {
        'content-type': contentType,
        'cache-control': 'private, no-store',
        'x-robots-tag': 'noindex, nofollow',
        'x-content-type-options': 'nosniff',
        'content-disposition': `inline; filename="enquiry-${id}.${extension}"`,
      },
    });
  } catch (error) {
    logServerError('leads: attachment read failed', error);
    if (error instanceof Error && error.name === 'EnvError') {
      return errorResponse(ERROR_CODES.CONFIGURATION_INCOMPLETE);
    }
    return toClientErrorResponse(error);
  }
}
