/**
 * `GET /api/admin/leads` — the filtered lead list, and its export.
 *
 * One endpoint, two representations, and that is the point rather than a shortcut.
 * Requirement 6.15 asks for "an export of the filtered leads": if the export were a second
 * route it would need its own copy of the filter parsing, and the two copies would
 * eventually disagree about what "the current filter" means — which is the one thing an
 * export must not get wrong. `?format=csv` therefore selects the representation of a
 * response the JSON path has already scoped, both built from the same `parseLeadQuery`
 * result and the same `whereFor` clause inside the store.
 *
 * Leads are read from D1, never from the content repository (Requirement 6.16), so this
 * endpoint takes no GitHub client at all: `openAdminContext` is deliberately not used
 * here, because assembling a repository client for a request that must never touch the
 * repository is exactly the kind of convenience that turns into an accident.
 *
 * Requirements: 6.12, 6.13, 6.14, 6.15, 6.16, 20.12, 25.7.
 */

import type { APIContext } from 'astro';

import {
  csvFilename,
  leadsToCsv,
  parseLeadQuery,
  queryLeads,
  queryLeadsForExport,
} from '@/lib/leads/store';
import {
  ERROR_CODES,
  errorResponse,
  jsonResponse,
  logServerError,
  toClientErrorResponse,
} from '@/lib/errors';
import { getD1 } from '@/lib/env';
import { requireAdmin } from '@/lib/auth/guard';

export const prerender = false;

export async function GET(context: APIContext): Promise<Response> {
  const guard = await requireAdmin(context, 'lead.read');
  if (!guard.ok) return guard.response;

  const query = parseLeadQuery(context.url.searchParams);
  const wantsCsv = context.url.searchParams.get('format') === 'csv';

  try {
    const db = getD1(context);

    if (wantsCsv) {
      const leads = await queryLeadsForExport(db, query);
      // `text/csv` with an explicit `attachment` disposition: the operator asked to
      // download a file, and a CSV rendered inline in a browser tab is not that.
      return new Response(leadsToCsv(leads), {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${csvFilename()}"`,
          // Personal data: never cached anywhere, never indexed.
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex, nofollow',
        },
      });
    }

    const page = await queryLeads(db, query);
    return jsonResponse({ ...page, query });
  } catch (error) {
    logServerError('leads: list failed', error);
    // A missing D1 binding is a deployment fault; the operator sees "not configured"
    // rather than an empty list, which would read as "no one has enquired".
    if (error instanceof Error && error.name === 'EnvError') {
      return errorResponse(ERROR_CODES.CONFIGURATION_INCOMPLETE);
    }
    return toClientErrorResponse(error);
  }
}
