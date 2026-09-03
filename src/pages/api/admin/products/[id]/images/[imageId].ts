/**
 * `PATCH  /api/admin/products/:id/images/:imageId` — alt text and primary designation.
 * `DELETE /api/admin/products/:id/images/:imageId` — soft delete.
 *
 * `altSource` records provenance: an operator's edit sets `admin`, and only the AI assistant
 * (task 11) may set `ai`. The distinction is what Requirement 15.15 asks for — "accept a
 * suggested alt text or replace it with their own, and record which of the two applies" — so
 * this endpoint refuses to let a caller claim `ai` for text a human typed: the field is not
 * in the request body at all. Editing alt text through this endpoint always means `admin`.
 *
 * Deletion is soft (Requirement 15.16). The image row leaves the product immediately — the
 * operator's intent is that it stops being shown — and the R2 objects are moved under
 * `deleted/`, recoverable for 30 days. The move runs after the response because it is one
 * read and one write per stored object, up to fifteen objects per image.
 *
 * Requirements: 13.8, 14.14, 14.15, 15.14, 15.15, 15.16.
 */

import type { APIContext } from 'astro';
import type { R2Bucket } from '@cloudflare/workers-types';
import { z } from 'zod';

import {
  ERROR_CODES,
  errorResponse,
  jsonResponse,
  logServerError,
  toClientErrorResponse,
} from '@/lib/errors';
import { getR2 } from '@/lib/env';
import { lockNamespace, openAdminContext } from '@/lib/admin/context';
import { readValidatedJson } from '@/lib/auth/guard';
import { resolveProduct, saveProductState } from '@/lib/github/drafts';
import { runAfterResponse } from '@/lib/admin/background';
import { softDeleteImage } from '@/lib/images/store';
import { validateProduct } from '@/lib/products/input';
import { withProductLock } from '@/lib/github/client';

export const prerender = false;

const ImagePatchInput = z
  .object({
    alt: z.string().max(180).optional(),
    primary: z.boolean().optional(),
  })
  .strict();

export async function PATCH(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'product.write');
  if (!opened.ok) return opened.response;

  const body = await readValidatedJson(context.request, ImagePatchInput);
  if (!body.ok) return body.response;

  const id = context.params.id ?? '';
  const imageId = context.params.imageId ?? '';
  const { drafts, client, actor } = opened.context;

  try {
    return await withProductLock(lockNamespace(context), id, async () => {
      const resolved = await resolveProduct({ drafts, client }, id);
      if (resolved === null) return errorResponse(ERROR_CODES.NOT_FOUND);
      const product = resolved.product;
      if (!product.images.some((image) => image.id === imageId)) {
        return errorResponse(ERROR_CODES.NOT_FOUND);
      }

      const images = product.images.map((image) =>
        image.id === imageId && body.value.alt !== undefined
          ? // An operator edit always flips provenance to `admin`, which is what makes the
            // "AI suggestion" chip in the editor disappear on edit (Requirement 16.4).
            { ...image, alt: body.value.alt, altSource: 'admin' as const }
          : image,
      );

      const primaryImage = body.value.primary === true ? imageId : product.primaryImage;

      const validated = validateProduct({
        ...product,
        images,
        ...(primaryImage === undefined ? {} : { primaryImage }),
        updatedAt: new Date().toISOString(),
      });
      if (!validated.ok) {
        return errorResponse(ERROR_CODES.VALIDATION_FAILED, { fields: validated.fields });
      }

      await saveProductState({
        drafts,
        client,
        product: validated.product,
        from: product.status,
        actor,
        action: body.value.primary === true ? 'set primary image' : 'edit image alt text',
      });

      return jsonResponse({
        images: validated.product.images,
        primaryImage: validated.product.primaryImage ?? null,
      });
    });
  } catch (error) {
    logServerError('images: patch failed', error);
    return toClientErrorResponse(error);
  }
}

export async function DELETE(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'product.write');
  if (!opened.ok) return opened.response;

  const id = context.params.id ?? '';
  const imageId = context.params.imageId ?? '';
  const { drafts, client, actor } = opened.context;

  let bucket: R2Bucket;
  try {
    bucket = getR2(context);
  } catch (error) {
    logServerError('images: MEDIA binding unavailable', error);
    return errorResponse(ERROR_CODES.CONFIGURATION_INCOMPLETE);
  }

  try {
    return await withProductLock(lockNamespace(context), id, async () => {
      const resolved = await resolveProduct({ drafts, client }, id);
      if (resolved === null) return errorResponse(ERROR_CODES.NOT_FOUND);
      const product = resolved.product;
      if (!product.images.some((image) => image.id === imageId)) {
        return errorResponse(ERROR_CODES.NOT_FOUND);
      }

      // Renumbered from 0 so the contiguity invariant survives a removal from the middle.
      const images = product.images
        .filter((image) => image.id !== imageId)
        .sort((a, b) => a.order - b.order)
        .map((image, index) => ({ ...image, order: index }));

      // The designation follows the images: removing the primary promotes the next one
      // rather than leaving a dangling reference the schema would reject (14.15).
      const primaryImage = product.primaryImage === imageId ? images[0]?.id : product.primaryImage;

      const candidate: Record<string, unknown> = {
        ...product,
        images,
        updatedAt: new Date().toISOString(),
      };
      // Deleting the last image leaves no primary to point at, and a stale reference is
      // exactly what invariant 5 rejects — so the key is removed, not set to null.
      if (primaryImage === undefined) delete candidate.primaryImage;
      else candidate.primaryImage = primaryImage;

      const validated = validateProduct(candidate);
      if (!validated.ok) {
        return errorResponse(ERROR_CODES.VALIDATION_FAILED, { fields: validated.fields });
      }

      await saveProductState({
        drafts,
        client,
        product: validated.product,
        from: product.status,
        actor,
        action: 'remove image',
      });

      await runAfterResponse(
        context.locals,
        softDeleteImage(bucket, product.id, imageId).then((result) => {
          if (result.failed.length > 0) {
            console.error(
              `[images] ${String(result.failed.length)} object(s) could not be moved to deleted/`,
            );
          }
        }),
      );

      return new Response(null, {
        status: 204,
        headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
      });
    });
  } catch (error) {
    logServerError('images: delete failed', error);
    return toClientErrorResponse(error);
  }
}
