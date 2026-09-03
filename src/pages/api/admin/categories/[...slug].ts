/**
 * `/api/admin/categories` and `/api/admin/categories/:slug`.
 *
 * | Method | Path | Action |
 * |---|---|---|
 * | `GET` | `/categories` | every category, in operator order |
 * | `GET` | `/categories/:slug` | one category |
 * | `POST` | `/categories` | create, ordered last |
 * | `PATCH` | `/categories` | reorder, as a single commit |
 * | `PATCH` | `/categories/:slug` | edit, publish, unpublish |
 * | `DELETE` | `/categories/:slug` | delete, refused when products are assigned |
 *
 * Categories are read from the **repository**, not from the bundled content collection.
 * The collection is baked at build time, so a category created five minutes ago would be
 * invisible to the admin until the next deploy — the admin has to see the source of truth
 * even when the built site has not caught up with it yet.
 *
 * Every write here alters what a visitor can browse, so none of them carry `[skip ci]`:
 * Requirement 18.3 promises a new category's route, navigation entry and filter option
 * appear after the next deploy with no code change, and that deploy is this commit's.
 *
 * Requirements: 18.2, 18.3, 18.4, 18.5, 17.7, 17.8, 17.16.
 */

import type { APIContext } from 'astro';

import {
  applyCategoryPatch,
  assignedProductCount,
  assignedProductsMessage,
  buildNewCategory,
  CategoryCreateInput,
  CategoryDeleteInput,
  CategoryPatchInput,
  CategoryReorderInput,
  reorderCategories,
  validateCategory,
} from '@/lib/categories/store';
import { categoryContentPath } from '@/lib/github/paths';
import { CategorySchema, type Category } from '@/schemas/category';
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
import { listProductSummaries } from '@/lib/products/index-store';
import { openAdminContext } from '@/lib/admin/context';
import { readValidatedJson } from '@/lib/auth/guard';
import type { GitHubContentClient } from '@/lib/github/client';

export const prerender = false;

/** The `[...slug]` rest parameter is `undefined` for the collection route. */
function slugOf(context: APIContext): string | null {
  const raw = context.params.slug;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? null : trimmed;
}

/** Every category in the repository, in operator order. */
async function loadCategories(client: GitHubContentClient): Promise<Category[]> {
  const slugs = await client.listCategorySlugs();
  const categories: Category[] = [];
  for (const slug of slugs) {
    const path = categoryContentPath(slug);
    if (path === null) continue;
    const record = await readContentRecord(client, path, CategorySchema);
    if (record !== null) categories.push(record.value);
  }
  return categories.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}

export async function GET(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'product.read');
  if (!opened.ok) return opened.response;
  const { client } = opened.context;
  const slug = slugOf(context);

  try {
    if (slug === null) {
      const categories = await loadCategories(client);
      const summaries = await listProductSummaries(opened.context.drafts);
      return jsonResponse({
        categories: categories.map((category) => ({
          ...category,
          // Shown in the list so the operator can see why a delete would be refused
          // before attempting it.
          assigned: assignedProductCount(summaries, category.slug),
        })),
      });
    }

    const path = categoryContentPath(slug);
    if (path === null) return errorResponse(ERROR_CODES.NOT_FOUND);
    const record = await readContentRecord(client, path, CategorySchema);
    if (record === null) return errorResponse(ERROR_CODES.NOT_FOUND);
    return jsonResponse({ category: record.value });
  } catch (error) {
    logServerError('categories: read failed', error);
    return toClientErrorResponse(error);
  }
}

export async function POST(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'settings.write');
  if (!opened.ok) return opened.response;
  if (slugOf(context) !== null) return errorResponse(ERROR_CODES.ROUTE_UNKNOWN);

  const body = await readValidatedJson(context.request, CategoryCreateInput);
  if (!body.ok) return body.response;

  const { client, actor } = opened.context;
  try {
    const existing = await loadCategories(client);
    const candidate = buildNewCategory(body.value, existing);
    const validated = validateCategory(candidate);
    if (!validated.ok) {
      return errorResponse(ERROR_CODES.VALIDATION_FAILED, { fields: validated.fields });
    }

    const path = categoryContentPath(validated.category.slug);
    if (path === null) return errorResponse(ERROR_CODES.PATH_NOT_ALLOWED);

    // No sha: create-if-absent. GitHub refuses a PUT without one over an existing file, so
    // a create can never overwrite a category that already occupies the slug.
    const result = await writeContentRecord({
      client,
      path,
      record: validated.category,
      scope: 'category',
      action: 'create',
      subject: { name: validated.category.name },
      actor,
      skipCi: false,
    });

    return jsonResponse(
      { slug: validated.category.slug, commitSha: result.commitSha, deployTriggered: true },
      { status: 201 },
    );
  } catch (error) {
    logServerError('categories: create failed', error);
    return toClientErrorResponse(error);
  }
}

export async function PATCH(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'settings.write');
  if (!opened.ok) return opened.response;
  const { client, actor } = opened.context;
  const slug = slugOf(context);

  // --- Reorder: the collection route, one commit for every file it moves ----
  if (slug === null) {
    const body = await readValidatedJson(context.request, CategoryReorderInput);
    if (!body.ok) return body.response;
    try {
      const existing = await loadCategories(client);
      if (existing.length === 0) return errorResponse(ERROR_CODES.NOT_FOUND);

      const assignments = reorderCategories(existing, body.value.order);
      const records: { path: string; record: Record<string, unknown> }[] = [];
      for (const assignment of assignments) {
        const category = existing.find((entry) => entry.slug === assignment.slug);
        if (category === undefined || category.order === assignment.order) continue;
        const path = categoryContentPath(assignment.slug);
        if (path === null) return errorResponse(ERROR_CODES.PATH_NOT_ALLOWED);
        records.push({ path, record: { order: assignment.order } });
      }
      if (records.length === 0) {
        return jsonResponse({ order: assignments, commitSha: null, deployTriggered: false });
      }

      const result = await writeContentRecords({
        client,
        records,
        scope: 'category',
        action: 'reorder',
        subject: { name: `${String(records.length)} categories` },
        actor,
        skipCi: false,
      });
      return jsonResponse({
        order: assignments,
        commitSha: result.commitSha,
        deployTriggered: true,
      });
    } catch (error) {
      logServerError('categories: reorder failed', error);
      return toClientErrorResponse(error);
    }
  }

  // --- Edit one category ----------------------------------------------------
  const body = await readValidatedJson(context.request, CategoryPatchInput);
  if (!body.ok) return body.response;

  try {
    const path = categoryContentPath(slug);
    if (path === null) return errorResponse(ERROR_CODES.NOT_FOUND);
    const record = await readContentRecord(client, path, CategorySchema);
    if (record === null) return errorResponse(ERROR_CODES.NOT_FOUND);

    const candidate = applyCategoryPatch(record.value, body.value.patch);
    const validated = validateCategory(candidate);
    if (!validated.ok) {
      return errorResponse(ERROR_CODES.VALIDATION_FAILED, { fields: validated.fields });
    }

    const result = await writeContentRecord({
      client,
      path,
      record: validated.category,
      scope: 'category',
      action: 'update',
      subject: { name: validated.category.name },
      actor,
      skipCi: false,
      sha: record.sha,
    });

    return jsonResponse({
      category: validated.category,
      commitSha: result.commitSha,
      deployTriggered: true,
    });
  } catch (error) {
    logServerError('categories: update failed', error);
    return toClientErrorResponse(error);
  }
}

export async function DELETE(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'settings.write');
  if (!opened.ok) return opened.response;
  const slug = slugOf(context);
  if (slug === null) return errorResponse(ERROR_CODES.ROUTE_UNKNOWN);

  const body = await readValidatedJson(context.request, CategoryDeleteInput);
  if (!body.ok) return body.response;

  const { client, actor, drafts } = opened.context;
  try {
    const path = categoryContentPath(slug);
    if (path === null) return errorResponse(ERROR_CODES.NOT_FOUND);
    const record = await readContentRecord(client, path, CategorySchema);
    if (record === null || record.sha === undefined) return errorResponse(ERROR_CODES.NOT_FOUND);

    if (body.value.confirmSlug !== slug) {
      return errorResponse(ERROR_CODES.CONFIRMATION_REQUIRED, {
        message: 'Type the category’s slug to confirm the deletion. Nothing has been deleted.',
        fields: { confirmSlug: ['This does not match the category’s slug.'] },
      });
    }

    // Requirement 18.4: refused, with the number of assigned products reported.
    const assigned = assignedProductCount(await listProductSummaries(drafts), slug);
    if (assigned.total > 0) {
      return errorResponse(ERROR_CODES.VALIDATION_FAILED, {
        message: assignedProductsMessage(assigned),
        fields: { category: [assignedProductsMessage(assigned)] },
        remote: assigned,
      });
    }

    const result = await deleteContentRecord({
      client,
      path,
      sha: record.sha,
      scope: 'category',
      subject: { name: record.value.name },
      actor,
    });

    return jsonResponse({ deleted: slug, commitSha: result.commitSha, deployTriggered: true });
  } catch (error) {
    logServerError('categories: delete failed', error);
    return toClientErrorResponse(error);
  }
}
