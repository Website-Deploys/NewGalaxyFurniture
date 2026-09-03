/**
 * POST /api/admin/rehydrate
 *
 * Rebuilds the KV working set from the repository.
 *
 * This endpoint is the operational proof of a design claim rather than a convenience:
 * KV holds drafts and the id → slug index, and the design says KV is a cache and never
 * the source of truth. That is only true if the cache can be thrown away, which is what
 * this does. It is also the recovery path after a namespace is recreated, after a
 * migration, or after someone edits `data/products/` by hand.
 *
 * It reports files it could not use rather than aborting on the first one: a single
 * hand-edited product must not block recovery of the rest.
 *
 * Requirements: 12.4, 17.1, 17.9.
 */

import type { APIContext } from 'astro';

import { createGitHubClient } from '@/lib/github/factory';
import { getKV } from '@/lib/env';
import { jsonResponse, logServerError, toClientErrorResponse } from '@/lib/errors';
import { rehydrateFromRepository } from '@/lib/github/drafts';
import { requireAdmin } from '@/lib/auth/guard';

export const prerender = false;

export async function POST(context: APIContext): Promise<Response> {
  const guard = await requireAdmin(context, 'product.write');
  if (!guard.ok) return guard.response;

  try {
    const client = createGitHubClient(context);
    const slugs = await client.listProductSlugs();
    const result = await rehydrateFromRepository({
      drafts: getKV(context, 'DRAFTS'),
      client,
      slugs,
    });
    // `skipped` carries slugs, which are public identifiers — no path, no upstream body.
    return jsonResponse(result);
  } catch (error) {
    logServerError('rehydrate: failed', error);
    return toClientErrorResponse(error);
  }
}
