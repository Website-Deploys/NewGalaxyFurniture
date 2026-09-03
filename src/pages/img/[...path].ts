/**
 * `GET /img/**` — image delivery.
 *
 * A pure R2 read. No transform, no decode, no database lookup: every byte this route can
 * serve was written at upload time, which is what lets the response carry
 * `public, max-age=31536000, immutable` honestly. Keys are content-addressed by image id, so
 * a replaced image is a new id and a new URL — the cache is never stale, and never has to be
 * purged (Requirement 15.9, 22.9).
 *
 * The route is public and unauthenticated, and the parser is what keeps that safe: only
 * `p_`/`img_`-shaped ids and ladder widths resolve, so the `deleted/` prefix and any other
 * object in the bucket are unreachable through it.
 *
 * `Vary: Accept` is required because the response format depends on the request's `Accept`.
 * Without it a shared cache would serve an AVIF to a client that cannot render one.
 *
 * Requirements: 15.9, 15.13, 22.9, 26.8.
 */

import type { APIContext } from 'astro';

import { getR2 } from '@/lib/env';
import { IMAGE_CACHE_CONTROL } from '@/lib/images/srcset';
import { keyCandidates, parseImageRequest } from '@/lib/images/delivery';
import { logServerError } from '@/lib/errors';

export const prerender = false;

/** A refusal carries no body: there is nothing useful to say to an image request. */
function notFound(): Response {
  return new Response(null, {
    status: 404,
    headers: { 'cache-control': 'public, max-age=60' },
  });
}

export async function GET(context: APIContext): Promise<Response> {
  const request = parseImageRequest(context.params.path ?? '');
  if (request === null) return notFound();

  let bucket;
  try {
    bucket = getR2(context);
  } catch (error) {
    logServerError('img: MEDIA binding unavailable', error);
    return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } });
  }

  const accept = context.request.headers.get('accept');
  for (const candidate of keyCandidates(request, accept)) {
    const object = await bucket.get(candidate.key);
    if (object === null) continue;
    return new Response(object.body as unknown as ReadableStream, {
      headers: {
        'content-type': object.httpMetadata?.contentType ?? candidate.contentType,
        'cache-control': IMAGE_CACHE_CONTROL,
        // The chosen format depends on the request's Accept, so caches must key on it.
        vary: 'Accept',
        etag: object.httpEtag,
      },
    });
  }

  return notFound();
}
