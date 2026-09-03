/**
 * `GET /api/admin/products` — the list.
 * `POST /api/admin/products` — create a draft.
 *
 * The list is served from the KV product index, so drawing the table costs one KV read
 * rather than one GitHub API call per row. The index is a cache of committed records and
 * is rebuildable with `POST /api/admin/rehydrate`, so it is never the authority for what
 * a product *is* — `GET /api/admin/products/:id` always resolves the record itself.
 *
 * Create takes a name and a category and nothing more (Requirement 12.3). The server
 * generates the id, the slug and the SKU (Requirement 13.13), stores the product as
 * `DRAFT` without applying the publish gate, and answers `201 { id, slug, sku }`.
 *
 * Requirements: 12.1, 12.2, 12.3, 13.13, 17.7, 17.8, 17.19, 25.1.
 */

import type { APIContext } from 'astro';

import { buildNewProduct, ProductCreateInput, validateProduct } from '@/lib/products/input';
import {
  ERROR_CODES,
  errorResponse,
  jsonResponse,
  logServerError,
  toClientErrorResponse,
} from '@/lib/errors';
import { listProductSummaries, takenIdentifiers } from '@/lib/products/index-store';
import { openAdminContext } from '@/lib/admin/context';
import { pageOfProducts, parseProductQuery } from '@/lib/products/query';
import { readValidatedJson } from '@/lib/auth/guard';
import { saveProductState } from '@/lib/github/drafts';

export const prerender = false;

export async function GET(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'product.read');
  if (!opened.ok) return opened.response;

  try {
    const summaries = await listProductSummaries(opened.context.drafts);
    const page = pageOfProducts(summaries, parseProductQuery(context.url.searchParams));
    return jsonResponse(page);
  } catch (error) {
    logServerError('products: list failed', error);
    return toClientErrorResponse(error);
  }
}

export async function POST(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'product.write');
  if (!opened.ok) return opened.response;

  const body = await readValidatedJson(context.request, ProductCreateInput);
  if (!body.ok) return body.response;

  try {
    const taken = await takenIdentifiers(opened.context.drafts);
    const candidate = buildNewProduct(body.value, { taken });

    // Re-validated server-side even though the server built it: a bug in the builder must
    // surface as a 422 naming the field, never as an invalid file in the repository.
    const validated = validateProduct(candidate);
    if (!validated.ok) {
      return errorResponse(ERROR_CODES.VALIDATION_FAILED, { fields: validated.fields });
    }

    const result = await saveProductState({
      drafts: opened.context.drafts,
      client: opened.context.client,
      product: validated.product,
      from: null,
      actor: opened.context.actor,
      action: 'create',
    });

    return jsonResponse(
      {
        id: validated.product.id,
        slug: validated.product.slug,
        sku: validated.product.sku,
        commitSha: result.commitSha,
      },
      { status: 201 },
    );
  } catch (error) {
    logServerError('products: create failed', error);
    return toClientErrorResponse(error);
  }
}
