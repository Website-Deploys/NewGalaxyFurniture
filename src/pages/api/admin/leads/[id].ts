/**
 * `PATCH /api/admin/leads/:id` — status and note.
 *
 * These are the only two mutable fields on a lead, and the schema is `.strict()` so a
 * request cannot reach a third. That matters more here than on a product: a lead is a
 * record of what a person actually said and when the server received it, so `name`,
 * `phone`, `message` and `created_at` are evidence, not content. There is no admin path
 * that edits them — `updateLead` has no parameter for them.
 *
 * The status is also the *only* record of a conversion in this system (Requirement 20.12):
 * no visitor event infers one, which is why an operator PATCH is the sole way `CONVERTED`
 * can appear anywhere.
 *
 * Requirements: 6.14, 20.12, 25.7.
 */

import type { APIContext } from 'astro';
import { z } from 'zod';

import { getLead, LeadStatusSchema, updateLead } from '@/lib/leads/store';
import {
  ERROR_CODES,
  errorResponse,
  jsonResponse,
  logServerError,
  toClientErrorResponse,
} from '@/lib/errors';
import { getD1 } from '@/lib/env';
import { readValidatedJson, requireAdmin } from '@/lib/auth/guard';

export const prerender = false;

/**
 * Both fields optional, and at least one required.
 *
 * `note` accepts `null` to clear it, which is distinct from omitting it: omitted leaves the
 * existing note alone, `null` erases it. Without that distinction "save the status" would
 * silently delete a follow-up note the operator had written.
 */
const LeadPatchInput = z
  .object({
    status: LeadStatusSchema.optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .refine((patch) => patch.status !== undefined || patch.note !== undefined, {
    message: 'Provide a status, a note, or both.',
  });

export async function PATCH(context: APIContext): Promise<Response> {
  const guard = await requireAdmin(context, 'lead.write');
  if (!guard.ok) return guard.response;

  const id = context.params.id;
  if (typeof id !== 'string' || id === '') return errorResponse(ERROR_CODES.NOT_FOUND);

  const body = await readValidatedJson(context.request, LeadPatchInput);
  if (!body.ok) return body.response;

  try {
    const db = getD1(context);
    // Existence is checked before the update rather than inferred from the row count:
    // an UPDATE that matched nothing and an UPDATE that changed nothing look identical
    // in D1, and the operator needs to know which happened.
    if ((await getLead(db, id)) === null) return errorResponse(ERROR_CODES.NOT_FOUND);

    const patch: { status?: typeof body.value.status; note?: string | null } = {};
    if (body.value.status !== undefined) patch.status = body.value.status;
    if (body.value.note !== undefined) {
      // An emptied textarea clears the note rather than storing "".
      patch.note =
        body.value.note === null || body.value.note.trim() === '' ? null : body.value.note.trim();
    }

    const lead = await updateLead(db, id, patch);
    if (lead === null) return errorResponse(ERROR_CODES.NOT_FOUND);
    return jsonResponse({ lead });
  } catch (error) {
    logServerError('leads: update failed', error);
    if (error instanceof Error && error.name === 'EnvError') {
      return errorResponse(ERROR_CODES.CONFIGURATION_INCOMPLETE);
    }
    return toClientErrorResponse(error);
  }
}
