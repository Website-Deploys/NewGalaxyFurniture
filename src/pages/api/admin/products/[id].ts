/**
 * `GET    /api/admin/products/:id` — resolve the record, draft first.
 * `PATCH  /api/admin/products/:id` — edit, with optimistic concurrency and rename control.
 * `DELETE /api/admin/products/:id` — remove, after an explicit confirmation.
 *
 * Three things this endpoint refuses to do, each one a requirement rather than a
 * preference:
 *
 * 1. **It never merges over a stale edit.** `expectedUpdatedAt` is the `updatedAt` the
 *    operator loaded; a mismatch returns `409 CONFLICT` carrying the current stored record
 *    so the UI can show a field-level diff. There is no last-writer-wins (17.10, 17.11).
 * 2. **It never moves a URL silently.** If the new name would change the slug, the patch is
 *    refused with `CONFIRMATION_REQUIRED` and the proposed slug, and nothing is written.
 *    Only `confirmSlugChange: true` performs the rename, which then writes the new file,
 *    deletes the old, and records the 301 in one commit (12.11, 12.12).
 * 3. **It never deletes on a bare request.** The caller must name the product's slug
 *    (12.7).
 *
 * Concurrent saves to the same product are serialised by the KV write lock, so the common
 * case — two admin tabs — is a short queue rather than a conflict (12.13).
 *
 * Requirements: 12.1, 12.4, 12.7, 12.11, 12.12, 12.13, 17.7–17.11, 17.19, 25.1.
 */

import type { APIContext } from 'astro';

import {
  applyProductPatch,
  ProductDeleteInput,
  ProductPatchInput,
  proposedSlugFor,
  validateProduct,
} from '@/lib/products/input';
import { deleteProductState, resolveProduct, saveProductState } from '@/lib/github/drafts';
import {
  ERROR_CODES,
  errorResponse,
  jsonResponse,
  logServerError,
  toClientErrorResponse,
} from '@/lib/errors';
import { lockNamespace, openAdminContext } from '@/lib/admin/context';
import { productUrlPath, renameProductState } from '@/lib/github/rename';
import { readValidatedJson } from '@/lib/auth/guard';
import { takenIdentifiers } from '@/lib/products/index-store';
import { withProductLock } from '@/lib/github/client';

export const prerender = false;

function productId(context: APIContext): string {
  return context.params.id ?? '';
}

export async function GET(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'product.read');
  if (!opened.ok) return opened.response;

  try {
    const resolved = await resolveProduct(
      { drafts: opened.context.drafts, client: opened.context.client },
      productId(context),
    );
    if (resolved === null) return errorResponse(ERROR_CODES.NOT_FOUND);
    return jsonResponse({ product: resolved.product, source: resolved.source });
  } catch (error) {
    logServerError('products: read failed', error);
    return toClientErrorResponse(error);
  }
}

export async function PATCH(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'product.write');
  if (!opened.ok) return opened.response;

  const body = await readValidatedJson(context.request, ProductPatchInput);
  if (!body.ok) return body.response;

  const id = productId(context);
  const { drafts, client, actor } = opened.context;

  try {
    return await withProductLock(lockNamespace(context), id, async () => {
      const resolved = await resolveProduct({ drafts, client }, id);
      if (resolved === null) return errorResponse(ERROR_CODES.NOT_FOUND);
      const current = resolved.product;

      if (current.updatedAt !== body.value.expectedUpdatedAt) {
        // The operator's values stay in their form; the stored record travels in `remote`.
        return errorResponse(ERROR_CODES.CONFLICT, { remote: current });
      }

      const candidate = applyProductPatch(current, body.value.patch);
      const validated = validateProduct(candidate);
      if (!validated.ok) {
        return errorResponse(ERROR_CODES.VALIDATION_FAILED, { fields: validated.fields });
      }

      // Rename detection. `taken` excludes this product so a rename never collides with
      // its own current slug.
      const taken = await takenIdentifiers(drafts, { exceptProductId: id });
      const proposedSlug =
        body.value.patch.name === undefined
          ? null
          : proposedSlugFor(current, validated.product.name, taken);

      if (proposedSlug !== null && body.value.confirmSlugChange !== true) {
        return errorResponse(ERROR_CODES.CONFIRMATION_REQUIRED, {
          fields: {
            name: [
              `Renaming this product moves its web address from ${productUrlPath(current.slug)} to ` +
                `${productUrlPath(proposedSlug)}. The old address will redirect. Confirm to continue.`,
            ],
          },
          remote: { currentSlug: current.slug, proposedSlug },
        });
      }

      if (proposedSlug !== null) {
        const renamed = { ...validated.product, slug: proposedSlug };
        const revalidated = validateProduct(renamed);
        if (!revalidated.ok) {
          return errorResponse(ERROR_CODES.VALIDATION_FAILED, { fields: revalidated.fields });
        }
        const result = await renameProductState({
          drafts,
          client,
          current,
          next: revalidated.product,
          actor,
        });
        return jsonResponse({
          product: revalidated.product,
          renamed: { from: result.fromSlug, to: result.toSlug, redirect: result.redirect },
          deployTriggered: result.deployTriggered,
        });
      }

      const result = await saveProductState({
        drafts,
        client,
        product: validated.product,
        // Not a lifecycle change: `from` equals the current status, so the commit is
        // marked `[skip ci]` exactly when the product is not public.
        from: current.status,
        actor,
        action: 'update',
      });

      return jsonResponse({
        product: validated.product,
        deployTriggered: result.deployTriggered,
        savedAt: validated.product.updatedAt,
      });
    });
  } catch (error) {
    logServerError('products: patch failed', error);
    return toClientErrorResponse(error);
  }
}

export async function DELETE(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'product.delete');
  if (!opened.ok) return opened.response;

  const body = await readValidatedJson(context.request, ProductDeleteInput);
  if (!body.ok) return body.response;

  const id = productId(context);
  const { drafts, client, actor } = opened.context;

  try {
    return await withProductLock(lockNamespace(context), id, async () => {
      const resolved = await resolveProduct({ drafts, client }, id);
      if (resolved === null) return errorResponse(ERROR_CODES.NOT_FOUND);

      if (body.value.confirmSlug !== resolved.product.slug) {
        return errorResponse(ERROR_CODES.CONFIRMATION_REQUIRED, {
          fields: {
            confirmSlug: [
              `Type the product's web address (${resolved.product.slug}) to confirm deletion.`,
            ],
          },
        });
      }

      await deleteProductState({ drafts, client, product: resolved.product, actor });
      // 204, so the client cannot mistake an empty body for a record.
      return new Response(null, {
        status: 204,
        headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
      });
    });
  } catch (error) {
    logServerError('products: delete failed', error);
    return toClientErrorResponse(error);
  }
}
