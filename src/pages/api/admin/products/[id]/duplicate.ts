/**
 * `POST /api/admin/products/:id/duplicate`
 *
 * The copy gets a fresh id, a fresh SKU, a slug distinct from every existing slug, and
 * `DRAFT` status (Requirement 12.5). The source is not touched (Requirement 12.6), and
 * that is guaranteed twice over:
 *
 * 1. `duplicateProduct` deep-clones and never writes to its argument.
 * 2. The copy is written with **create semantics — no blob `sha`** — so if the derived path
 *    ever collided with an existing file, GitHub would refuse the write rather than
 *    overwrite it. `saveProductState` reads the target path first and only supplies a
 *    `sha` when a file is already there, so the assertion worth making explicit is that a
 *    fresh slug means a fresh path: `uniqueSlug` is seeded from every slug in the index,
 *    so the path cannot be the source's.
 *
 * Requirements: 12.5, 12.6.
 */

import type { APIContext } from 'astro';

import { duplicateProduct } from '@/lib/products/duplicate';
import {
  ERROR_CODES,
  errorResponse,
  jsonResponse,
  logServerError,
  toClientErrorResponse,
} from '@/lib/errors';
import { openAdminContext } from '@/lib/admin/context';
import { productContentPath } from '@/lib/github/paths';
import { resolveProduct, saveProductState } from '@/lib/github/drafts';
import { takenIdentifiers } from '@/lib/products/index-store';
import { validateProduct } from '@/lib/products/input';

export const prerender = false;

export async function POST(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'product.write');
  if (!opened.ok) return opened.response;

  const id = context.params.id ?? '';
  const { drafts, client, actor } = opened.context;

  try {
    const resolved = await resolveProduct({ drafts, client }, id);
    if (resolved === null) return errorResponse(ERROR_CODES.NOT_FOUND);
    const source = resolved.product;

    const taken = await takenIdentifiers(drafts);
    const copy = duplicateProduct(source, taken);

    const validated = validateProduct(copy);
    if (!validated.ok) {
      return errorResponse(ERROR_CODES.VALIDATION_FAILED, { fields: validated.fields });
    }

    // Belt and braces on "never clobbers its source": if the derived paths matched, the
    // duplicate would be a write over the original, so refuse before touching GitHub.
    if (productContentPath(validated.product.slug) === productContentPath(source.slug)) {
      console.error('[products] duplicate derived the source path — refusing');
      return errorResponse(ERROR_CODES.INTERNAL_ERROR);
    }

    await saveProductState({
      drafts,
      client,
      product: validated.product,
      from: null,
      actor,
      action: 'duplicate',
    });

    return jsonResponse(
      {
        id: validated.product.id,
        slug: validated.product.slug,
        sku: validated.product.sku,
        sourceId: source.id,
      },
      { status: 201 },
    );
  } catch (error) {
    logServerError('products: duplicate failed', error);
    return toClientErrorResponse(error);
  }
}
