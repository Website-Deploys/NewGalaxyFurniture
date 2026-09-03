/**
 * `/api/admin/reviews` and `/api/admin/reviews/:id`.
 *
 * | Method | Path | Action |
 * |---|---|---|
 * | `GET` | `/reviews` | every review, operator order, featured first |
 * | `GET` | `/reviews/:id` | one review |
 * | `POST` | `/reviews` | create — always `DRAFT` |
 * | `PATCH` | `/reviews` | reorder, as a single commit |
 * | `PATCH` | `/reviews/:id` | edit, feature, publish, unpublish |
 * | `DELETE` | `/reviews/:id` | delete, confirmed by id |
 *
 * Publication is a field on the `PATCH`, not a consequence of an edit: a review saved with
 * new text keeps whatever status it had, and only `{ status: 'PUBLISHED' }` makes it public
 * (Requirement 18.8). Nothing in this file supplies review content — see
 * `src/lib/reviews/store.ts` (Requirement 18.9).
 *
 * A write that leaves the review invisible both before and after carries `[skip ci]`, so
 * drafting reviews does not spend production builds (Requirement 17.14).
 *
 * Requirements: 18.6, 18.7, 18.8, 18.9, 17.7, 17.8, 17.14, 17.16.
 */

import type { APIContext } from 'astro';

import {
  applyReviewPatch,
  buildNewReview,
  reorderReviews,
  ReviewCreateInput,
  ReviewDeleteInput,
  ReviewPatchInput,
  ReviewReorderInput,
  reviewWriteSkipsCi,
  validateReview,
} from '@/lib/reviews/store';
import {
  deleteContentRecord,
  readContentRecord,
  writeContentRecord,
  writeContentRecords,
} from '@/lib/github/content-writer';
import {
  ERROR_CODES,
  errorResponse,
  jsonResponse,
  logServerError,
  toClientErrorResponse,
} from '@/lib/errors';
import { openAdminContext } from '@/lib/admin/context';
import { readValidatedJson } from '@/lib/auth/guard';
import { reviewContentPath } from '@/lib/github/paths';
import { ReviewSchema, type Review } from '@/schemas/review';
import type { GitHubContentClient } from '@/lib/github/client';

export const prerender = false;

function idOf(context: APIContext): string | null {
  const raw = context.params.id;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? null : trimmed;
}

async function loadReviews(client: GitHubContentClient): Promise<Review[]> {
  const ids = await client.listReviewIds();
  const reviews: Review[] = [];
  for (const id of ids) {
    const path = reviewContentPath(id);
    if (path === null) continue;
    const record = await readContentRecord(client, path, ReviewSchema);
    if (record !== null) reviews.push(record.value);
  }
  return reviews.sort(
    (a, b) =>
      Number(b.featured) - Number(a.featured) || a.order - b.order || a.id.localeCompare(b.id),
  );
}

export async function GET(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'product.read');
  if (!opened.ok) return opened.response;
  const { client } = opened.context;
  const id = idOf(context);

  try {
    if (id === null) return jsonResponse({ reviews: await loadReviews(client) });
    const path = reviewContentPath(id);
    if (path === null) return errorResponse(ERROR_CODES.NOT_FOUND);
    const record = await readContentRecord(client, path, ReviewSchema);
    if (record === null) return errorResponse(ERROR_CODES.NOT_FOUND);
    return jsonResponse({ review: record.value });
  } catch (error) {
    logServerError('reviews: read failed', error);
    return toClientErrorResponse(error);
  }
}

export async function POST(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'review.write');
  if (!opened.ok) return opened.response;
  if (idOf(context) !== null) return errorResponse(ERROR_CODES.ROUTE_UNKNOWN);

  const body = await readValidatedJson(context.request, ReviewCreateInput);
  if (!body.ok) return body.response;

  const { client, actor } = opened.context;
  try {
    const existing = await loadReviews(client);
    const validated = validateReview(buildNewReview(body.value, existing));
    if (!validated.ok) {
      return errorResponse(ERROR_CODES.VALIDATION_FAILED, { fields: validated.fields });
    }

    const path = reviewContentPath(validated.review.id);
    if (path === null) return errorResponse(ERROR_CODES.PATH_NOT_ALLOWED);

    const result = await writeContentRecord({
      client,
      path,
      record: validated.review,
      scope: 'review',
      action: 'create',
      subject: { name: `review by ${validated.review.customerName}` },
      actor,
      // A new review is a draft, so it changes nothing a visitor sees.
      skipCi: true,
    });

    return jsonResponse(
      { id: validated.review.id, status: validated.review.status, commitSha: result.commitSha },
      { status: 201 },
    );
  } catch (error) {
    logServerError('reviews: create failed', error);
    return toClientErrorResponse(error);
  }
}

export async function PATCH(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'review.write');
  if (!opened.ok) return opened.response;
  const { client, actor } = opened.context;
  const id = idOf(context);

  // --- Reorder --------------------------------------------------------------
  if (id === null) {
    const body = await readValidatedJson(context.request, ReviewReorderInput);
    if (!body.ok) return body.response;
    try {
      const existing = await loadReviews(client);
      if (existing.length === 0) return errorResponse(ERROR_CODES.NOT_FOUND);

      const assignments = reorderReviews(existing, body.value.order);
      const records: { path: string; record: Record<string, unknown> }[] = [];
      let touchesPublished = false;
      for (const assignment of assignments) {
        const review = existing.find((entry) => entry.id === assignment.id);
        if (review === undefined || review.order === assignment.order) continue;
        const path = reviewContentPath(assignment.id);
        if (path === null) return errorResponse(ERROR_CODES.PATH_NOT_ALLOWED);
        if (review.status === 'PUBLISHED') touchesPublished = true;
        records.push({ path, record: { order: assignment.order } });
      }
      if (records.length === 0) {
        return jsonResponse({ order: assignments, commitSha: null, deployTriggered: false });
      }

      const result = await writeContentRecords({
        client,
        records,
        scope: 'review',
        action: 'reorder',
        subject: { name: `${String(records.length)} reviews` },
        actor,
        // Reordering drafts changes nothing public; reordering published reviews does.
        skipCi: !touchesPublished,
      });
      return jsonResponse({
        order: assignments,
        commitSha: result.commitSha,
        deployTriggered: touchesPublished,
      });
    } catch (error) {
      logServerError('reviews: reorder failed', error);
      return toClientErrorResponse(error);
    }
  }

  // --- Edit one review ------------------------------------------------------
  const body = await readValidatedJson(context.request, ReviewPatchInput);
  if (!body.ok) return body.response;

  try {
    const path = reviewContentPath(id);
    if (path === null) return errorResponse(ERROR_CODES.NOT_FOUND);
    const record = await readContentRecord(client, path, ReviewSchema);
    if (record === null) return errorResponse(ERROR_CODES.NOT_FOUND);

    const candidate = applyReviewPatch(record.value, body.value.patch, body.value.status);
    const validated = validateReview(candidate);
    if (!validated.ok) {
      return errorResponse(ERROR_CODES.VALIDATION_FAILED, { fields: validated.fields });
    }

    const skipCi = reviewWriteSkipsCi(record.value.status, validated.review.status);
    const result = await writeContentRecord({
      client,
      path,
      record: validated.review,
      scope: 'review',
      action:
        body.value.status === undefined
          ? 'update'
          : body.value.status === 'PUBLISHED'
            ? 'publish'
            : body.value.status === 'UNPUBLISHED'
              ? 'unpublish'
              : 'update',
      subject: { name: `review by ${validated.review.customerName}` },
      actor,
      skipCi,
      sha: record.sha,
    });

    return jsonResponse({
      review: validated.review,
      commitSha: result.commitSha,
      deployTriggered: !skipCi,
    });
  } catch (error) {
    logServerError('reviews: update failed', error);
    return toClientErrorResponse(error);
  }
}

export async function DELETE(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'review.publish');
  if (!opened.ok) return opened.response;
  const id = idOf(context);
  if (id === null) return errorResponse(ERROR_CODES.ROUTE_UNKNOWN);

  const body = await readValidatedJson(context.request, ReviewDeleteInput);
  if (!body.ok) return body.response;

  const { client, actor } = opened.context;
  try {
    const path = reviewContentPath(id);
    if (path === null) return errorResponse(ERROR_CODES.NOT_FOUND);
    const record = await readContentRecord(client, path, ReviewSchema);
    if (record === null || record.sha === undefined) return errorResponse(ERROR_CODES.NOT_FOUND);

    if (body.value.confirmId !== id) {
      return errorResponse(ERROR_CODES.CONFIRMATION_REQUIRED, {
        message: 'Confirm the review id to delete it. Nothing has been deleted.',
        fields: { confirmId: ['This does not match the review’s id.'] },
      });
    }

    const result = await deleteContentRecord({
      client,
      path,
      sha: record.sha,
      scope: 'review',
      subject: { name: `review by ${record.value.customerName}` },
      actor,
    });

    return jsonResponse({ deleted: id, commitSha: result.commitSha, deployTriggered: true });
  } catch (error) {
    logServerError('reviews: delete failed', error);
    return toClientErrorResponse(error);
  }
}
