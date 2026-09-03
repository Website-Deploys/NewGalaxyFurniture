/**
 * `/img/**` request parsing and format negotiation.
 *
 * Pure, so the interesting decisions — which R2 key a URL maps to, and which format a
 * browser gets — are unit testable without a bucket or a request.
 *
 * The URL shape is `/img/{productId}/{imageId}-{width}.{format}`, with
 * `/img/{productId}/{imageId}-original.{ext}` for the pre-derivative fallback. Both ids are
 * matched against the schema's own patterns, so the path cannot name an arbitrary R2 key:
 * this route reads from a bucket that also holds soft-deleted objects under `deleted/`, and
 * a permissive parser would make those readable. `p_`/`img_` prefixes and fixed lengths make
 * that unreachable rather than merely unlikely.
 *
 * Negotiation upgrades rather than downgrades. A `.webp` URL is served as AVIF to a browser
 * that accepts AVIF, because the markup emits one `srcset` and lets the edge choose
 * (Requirement 15.9). The response therefore carries `Vary: Accept`, without which a shared
 * cache would hand an AVIF to a client that cannot display it.
 *
 * Requirements: 15.9, 15.13, 22.9.
 */

import { DERIVATIVE_WIDTHS, derivativeKey, originalKey } from './srcset';
import type { DerivativeFormatValue } from '@/schemas/product';

const PRODUCT_ID = /^p_[a-z0-9]{10}$/;
const IMAGE_ID = /^img_[a-z0-9]{10}$/;
const ORIGINAL_EXT = /^(jpg|png|webp|avif)$/;

export type ImageRequest =
  | {
      kind: 'derivative';
      productId: string;
      imageId: string;
      width: number;
      format: DerivativeFormatValue;
    }
  | { kind: 'original'; productId: string; imageId: string; ext: string };

/** `jpg` in a URL, `jpeg` in the format vocabulary. */
function normalizeFormat(value: string): DerivativeFormatValue | null {
  if (value === 'avif' || value === 'webp' || value === 'jpeg') return value;
  if (value === 'jpg') return 'jpeg';
  return null;
}

/**
 * Parse a `/img/**` path, or refuse it.
 *
 * Widths are restricted to the ladder. An unbounded width would let a crawler enumerate
 * cache entries that can never exist, and every width this project writes is on the ladder —
 * except the narrow-original fallback, which is why an off-ladder width below the smallest
 * rung is also accepted.
 */
export function parseImageRequest(path: string): ImageRequest | null {
  const segments = path.replace(/^\/+/, '').split('/');
  if (segments.length !== 2) return null;
  const [productId, file] = segments;
  if (productId === undefined || file === undefined) return null;
  if (!PRODUCT_ID.test(productId)) return null;

  const separator = file.lastIndexOf('-');
  const dot = file.lastIndexOf('.');
  if (separator === -1 || dot === -1 || dot < separator) return null;

  const imageId = file.slice(0, separator);
  const middle = file.slice(separator + 1, dot);
  const extension = file.slice(dot + 1);
  if (!IMAGE_ID.test(imageId)) return null;

  if (middle === 'original') {
    if (!ORIGINAL_EXT.test(extension)) return null;
    return { kind: 'original', productId, imageId, ext: extension };
  }

  if (!/^[0-9]{1,5}$/.test(middle)) return null;
  const width = Number.parseInt(middle, 10);
  const smallest = DERIVATIVE_WIDTHS[0] ?? 320;
  if (!DERIVATIVE_WIDTHS.includes(width) && !(width > 0 && width < smallest)) return null;

  const format = normalizeFormat(extension);
  if (format === null) return null;
  return { kind: 'derivative', productId, imageId, width, format };
}

/** True when the client's `Accept` admits this media type, wildcards included. */
export function acceptsFormat(accept: string | null, mime: string): boolean {
  if (accept === null || accept.trim() === '') return false;
  const lowered = accept.toLowerCase();
  if (lowered.includes(mime)) return true;
  return lowered.includes('image/*') || lowered.includes('*/*');
}

/**
 * The formats to try, best first.
 *
 * The requested format is always in the list and always last, so negotiation can only ever
 * *add* candidates: a client that accepts nothing modern still gets exactly what it asked
 * for.
 */
export function negotiatedFormats(
  requested: DerivativeFormatValue,
  accept: string | null,
): DerivativeFormatValue[] {
  const order: DerivativeFormatValue[] = [];
  if (acceptsFormat(accept, 'image/avif')) order.push('avif');
  if (acceptsFormat(accept, 'image/webp')) order.push('webp');
  order.push(requested);
  return [...new Set(order)];
}

export interface KeyCandidate {
  key: string;
  contentType: string;
}

const CONTENT_TYPE: Record<DerivativeFormatValue, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
};

const ORIGINAL_CONTENT_TYPE: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

/**
 * The R2 keys to try in order for a request.
 *
 * For a derivative: the negotiated formats at the requested width, then the stored original
 * as the last resort — which is what makes Requirement 15.13 true, since a request that
 * arrives before generation finishes still returns the image rather than a 404.
 */
export function keyCandidates(request: ImageRequest, accept: string | null): KeyCandidate[] {
  if (request.kind === 'original') {
    return [
      {
        key: originalKey(request.productId, request.imageId, request.ext),
        contentType: ORIGINAL_CONTENT_TYPE[request.ext] ?? 'application/octet-stream',
      },
    ];
  }

  const candidates: KeyCandidate[] = negotiatedFormats(request.format, accept).map((format) => ({
    key: derivativeKey(request.productId, request.imageId, request.width, format),
    contentType: CONTENT_TYPE[format],
  }));

  for (const ext of ['jpg', 'webp', 'png', 'avif'] as const) {
    candidates.push({
      key: originalKey(request.productId, request.imageId, ext),
      contentType: ORIGINAL_CONTENT_TYPE[ext] ?? 'application/octet-stream',
    });
  }

  return candidates;
}
