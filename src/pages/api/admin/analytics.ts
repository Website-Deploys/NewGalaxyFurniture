/**
 * `GET /api/admin/analytics?from&to` — the `AnalyticsSummary` for a range.
 *
 * The endpoint is a thin shell over `analyticsSummary`, deliberately: every judgement about what
 * a figure means lives in `src/lib/analytics/queries.ts`, where it is testable without a request,
 * and the honest limits travel with the payload rather than being duplicated in the template.
 *
 * A failure returns an error, never an empty summary. "No events in this range" and "the store
 * could not be read" are different facts and the UI shows different things for them
 * (Requirements 20.9, 20.10).
 *
 * Requirements: 20.5, 20.6, 20.7, 20.8, 20.9, 20.10, 20.12.
 */

import type { APIContext } from 'astro';

import { analyticsSummary, HONEST_LIMITS, parseRange } from '@/lib/analytics/queries';
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
  const guard = await requireAdmin(context, 'analytics.read');
  if (!guard.ok) return guard.response;

  const range = parseRange(context.url.searchParams);

  try {
    const summary = await analyticsSummary(getD1(context), range);
    return jsonResponse({ summary, limits: HONEST_LIMITS });
  } catch (error) {
    logServerError('analytics: read failed', error);
    if (error instanceof Error && error.name === 'EnvError') {
      return errorResponse(ERROR_CODES.CONFIGURATION_INCOMPLETE);
    }
    return toClientErrorResponse(error);
  }
}
