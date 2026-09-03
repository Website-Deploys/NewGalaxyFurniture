/**
 * `PATCH /api/admin/products/:id/images/order` — reorder a product's images.
 *
 * The body is the complete ordered list of image ids. The server renumbers `order` from 0
 * over that list, so the contiguity invariant holds by construction rather than by the
 * client having computed the right integers (Requirements 14.14, 15.14).
 *
 * A list that is not a permutation of the product's own image ids is refused. Accepting a
 * partial list would silently drop images; accepting an unknown id would mean the client
 * decided what belongs to the product.
 *
 * Requirements: 14.14, 15.14.
 */

import type { APIContext } from 'astro';
import { z } from 'zod';

import {
  ERROR_CODES,
  errorResponse,
  jsonResponse,
  logServerError,
  toClientErrorResponse,
} from '@/lib/errors';
import { lockNamespace, openAdminContext } from '@/lib/admin/context';
import { readValidatedJson } from '@/lib/auth/guard';
import { resolveProduct, saveProductState } from '@/lib/github/drafts';
import { validateProduct } from '@/lib/products/input';
import { withProductLock } from '@/lib/github/client';

export const prerender = false;

const OrderInput = z.object({ orderedIds: z.array(z.string()).min(1).max(20) }).strict();

export async function PATCH(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'product.write');
  if (!opened.ok) return opened.response;

  const body = await readValidatedJson(context.request, OrderInput);
  if (!body.ok) return body.response;

  const id = context.params.id ?? '';
  const { drafts, client, actor } = opened.context;

  try {
    return await withProductLock(lockNamespace(context), id, async () => {
      const resolved = await resolveProduct({ drafts, client }, id);
      if (resolved === null) return errorResponse(ERROR_CODES.NOT_FOUND);
      const product = resolved.product;

      const requested = body.value.orderedIds;
      const owned = new Set(product.images.map((image) => image.id));
      const isPermutation =
        requested.length === owned.size &&
        new Set(requested).size === requested.length &&
        requested.every((imageId) => owned.has(imageId));
      if (!isPermutation) {
        return errorResponse(ERROR_CODES.VALIDATION_FAILED, {
          fields: {
            orderedIds: ['Send every image of this product exactly once, in the new order.'],
          },
        });
      }

      const byId = new Map(product.images.map((image) => [image.id, image]));
      const images = requested.map((imageId, index) => ({
        ...(byId.get(imageId) as NonNullable<ReturnType<typeof byId.get>>),
        order: index,
      }));

      const validated = validateProduct({
        ...product,
        images,
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
        action: 'reorder images',
      });

      return jsonResponse({ images: validated.product.images });
    });
  } catch (error) {
    logServerError('images: reorder failed', error);
    return toClientErrorResponse(error);
  }
}
