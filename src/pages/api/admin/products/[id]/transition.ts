/**
 * `POST /api/admin/products/:id/transition` — the only way a product changes status.
 *
 * Every gate the lifecycle depends on is applied here, in `applyTransition`:
 * reachability in the declared machine, `product.publish` for a public target, and the
 * publish gate against the **candidate** record (Requirements 14.2–14.6). A gate failure
 * returns `422` with the failures keyed by field, so the editor can render each one
 * against the control that caused it (Requirement 14.5).
 *
 * The endpoint is also the enforcement point for Requirement 14.10 — publication only
 * from an authenticated interactive action. That is not a check in this file: it is the
 * type of the argument. `applyTransition` demands an `InteractiveActor`, which only
 * `openAdminContext` can mint, and only from a live session. A cron trigger or queue
 * consumer cannot call it at all.
 *
 * What the response does **not** claim is as important as what it does: `deployTriggered`
 * says a commit that will start a build has landed, not that the site is live. The UI polls
 * `/api/admin/deploy-status` for that (Requirements 14.12, 14.13).
 *
 * Requirements: 14.2, 14.3, 14.4, 14.5, 14.9, 14.10, 14.12, 12.8, 26.6.
 */

import type { APIContext } from 'astro';

import { applyTransition } from '@/lib/products/transitions';
import {
  ERROR_CODES,
  errorResponse,
  jsonResponse,
  logServerError,
  toClientErrorResponse,
} from '@/lib/errors';
import { lockNamespace, openAdminContext } from '@/lib/admin/context';
import { ProductTransitionInput } from '@/lib/products/input';
import { readValidatedJson } from '@/lib/auth/guard';
import { resolveProduct, saveProductState } from '@/lib/github/drafts';
import { transitionAction } from '@/lib/products/transitions';
import { withProductLock } from '@/lib/github/client';

export const prerender = false;

/** The subject verb for the commit message: `publish`, `unpublish`, `update`, … */
function commitVerb(action: string): string {
  return action.toLowerCase().replace(/_/g, ' ');
}

export async function POST(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'product.write');
  if (!opened.ok) return opened.response;

  const body = await readValidatedJson(context.request, ProductTransitionInput);
  if (!body.ok) return body.response;

  const id = context.params.id ?? '';
  const { drafts, client, actor } = opened.context;

  try {
    return await withProductLock(lockNamespace(context), id, async () => {
      const resolved = await resolveProduct({ drafts, client }, id);
      if (resolved === null) return errorResponse(ERROR_CODES.NOT_FOUND);
      const current = resolved.product;

      const outcome = applyTransition(current, body.value.to, actor);
      if (!outcome.ok) {
        if (outcome.code === 'PUBLISH_GATE_FAILED') {
          return errorResponse(ERROR_CODES.PUBLISH_GATE_FAILED, { fields: outcome.fields });
        }
        return errorResponse(ERROR_CODES.TRANSITION_NOT_ALLOWED);
      }

      const action = transitionAction(current.status, outcome.product.status);
      const result = await saveProductState({
        drafts,
        client,
        product: outcome.product,
        from: current.status,
        actor,
        action: commitVerb(action),
      });

      return jsonResponse({
        product: outcome.product,
        deployTriggered: result.deployTriggered,
        commitSha: result.commitSha,
      });
    });
  } catch (error) {
    logServerError('products: transition failed', error);
    return toClientErrorResponse(error);
  }
}
