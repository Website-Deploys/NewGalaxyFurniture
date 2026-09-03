/**
 * `POST /api/admin/products/:id/images` — multipart upload.
 *
 * The shape of this handler is the design's staging, and the ordering is the point:
 *
 * 1. `Content-Length` is checked before the body is read, so a 40 MB upload costs nothing.
 * 2. Each file is validated independently — sniffed, dimension-checked, then decoded — and a
 *    rejection names its own reason and leaves the rest of the batch alone (Requirement 26.8).
 * 3. The **sanitized original** is written to R2 immediately. It is re-encoded from decoded
 *    pixels, so EXIF GPS and any appended payload are gone by construction (15.6).
 * 4. The image is appended to the product with `derivativesReady: false`, and the response
 *    returns.
 * 5. Derivatives are generated in `ctx.waitUntil` **after** the response. AVIF encoding is
 *    hundreds of milliseconds per width; doing it inline would make a ten-photograph upload
 *    feel broken and would risk the Worker CPU limit. The admin UI shows "optimizing" until
 *    `derivativesReady` flips (15.13).
 *
 * The object key is built server-side from the product id, a generated image id and the
 * *sniffed* extension. The client's filename is kept only as a display label. There is no
 * code path from a client string to an R2 key (15.7).
 *
 * Requirements: 15.1–15.13, 25.6, 26.8.
 */

import type { APIContext } from 'astro';
import type { R2Bucket } from '@cloudflare/workers-types';

import { buildLqip, generateDerivatives, sanitizeOriginal } from '@/lib/images/derivatives';
import { checkContentLength, generateImageId, validateUpload } from '@/lib/images/validate';
import { consumeNamedLimit } from '@/lib/auth/rate-limit';
import { createWorkerCodec } from '@/lib/images/codec-photon';
import {
  ERROR_CODES,
  errorResponse,
  jsonResponse,
  logServerError,
  minutesPhrase,
  toClientErrorResponse,
} from '@/lib/errors';
import { getKV, getR2 } from '@/lib/env';
import { lockNamespace, openAdminContext } from '@/lib/admin/context';
import { originalKey } from '@/lib/images/srcset';
import { putImageObject } from '@/lib/images/store';
import { resolveProduct, saveProductState } from '@/lib/github/drafts';
import { runAfterResponse } from '@/lib/admin/background';
import { validateProduct } from '@/lib/products/input';
import { withProductLock } from '@/lib/github/client';
import type { ImageCodec, RawImage } from '@/lib/images/codec';
import type { ProductImageValue } from '@/schemas/product';

export const prerender = false;

export const MAX_IMAGES_PER_PRODUCT = 20;

interface AcceptedUpload {
  record: ProductImageValue;
  raw: RawImage;
}

interface RejectedUpload {
  filename: string;
  code: string;
  message: string;
}

export async function POST(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'product.write');
  if (!opened.ok) return opened.response;

  // 1. Refuse an oversized body before reading it.
  const declared = Number.parseInt(context.request.headers.get('content-length') ?? '', 10);
  const tooLarge = checkContentLength(Number.isFinite(declared) ? declared : null);
  if (tooLarge !== null && !tooLarge.ok) {
    return errorResponse(ERROR_CODES.VALIDATION_FAILED, {
      message: tooLarge.error.message,
      fields: { files: [tooLarge.error.message] },
    });
  }

  const id = context.params.id ?? '';
  const { drafts, client, actor } = opened.context;

  let bucket: R2Bucket;
  let codec: ImageCodec;
  try {
    bucket = getR2(context);
    codec = createWorkerCodec();
  } catch (error) {
    logServerError('images: media pipeline unavailable', error);
    return errorResponse(ERROR_CODES.CONFIGURATION_INCOMPLETE);
  }

  // 30 uploads per 10 minutes per session, from the design's abuse-control table.
  try {
    const decision = await consumeNamedLimit(
      getKV(context, 'RATELIMIT'),
      'imageUpload',
      opened.context.session.id,
    );
    if (!decision.allowed) {
      return errorResponse(ERROR_CODES.RATE_LIMITED, {
        message: `Upload limit reached. Try again in ${minutesPhrase(decision.retryAfterMinutes)}.`,
        headers: { 'retry-after': String(Math.ceil(decision.retryAfterMinutes * 60)) },
      });
    }
  } catch (error) {
    logServerError('images: upload rate limit unavailable', error);
    return errorResponse(ERROR_CODES.CONFIGURATION_INCOMPLETE);
  }

  let files: File[];
  try {
    const form = await context.request.formData();
    files = form.getAll('file').filter((entry): entry is File => entry instanceof File);
  } catch {
    return errorResponse(ERROR_CODES.VALIDATION_FAILED, {
      message: 'The upload could not be read. Try again.',
      fields: { files: ['The upload could not be read.'] },
    });
  }
  if (files.length === 0) {
    return errorResponse(ERROR_CODES.VALIDATION_FAILED, {
      fields: { files: ['Choose at least one image to upload.'] },
    });
  }

  try {
    return await withProductLock(lockNamespace(context), id, async () => {
      const resolved = await resolveProduct({ drafts, client }, id);
      if (resolved === null) return errorResponse(ERROR_CODES.NOT_FOUND);
      const product = resolved.product;

      const accepted: AcceptedUpload[] = [];
      const rejected: RejectedUpload[] = [];
      const order = product.images.length;

      for (const file of files) {
        if (order + accepted.length >= MAX_IMAGES_PER_PRODUCT) {
          rejected.push({
            filename: file.name,
            code: 'TOO_MANY_IMAGES',
            message: `This product already has the maximum of ${String(MAX_IMAGES_PER_PRODUCT)} images.`,
          });
          continue;
        }

        // 2. Validation, including the decode, which is also the metadata strip.
        const outcome = await validateUpload(file, (bytes, type) => codec.decode(bytes, type));
        if (!outcome.ok) {
          rejected.push({
            filename: file.name,
            code: outcome.error.code,
            message: outcome.error.message,
          });
          continue;
        }

        const decoded = outcome.image;
        const pixels = decoded.pixels;
        if (pixels === undefined) {
          rejected.push({
            filename: file.name,
            code: 'DECODE_FAILED',
            message: 'This file could not be opened as an image. Re-export it and try again.',
          });
          continue;
        }
        const raw: RawImage = { width: decoded.width, height: decoded.height, rgba: pixels };

        const imageId = generateImageId();
        // 3. The sanitized original, at a server-generated key.
        const sanitized = await sanitizeOriginal(codec, raw, decoded.type.format);
        const key = originalKey(product.id, imageId, sanitized.ext);
        await putImageObject(bucket, {
          key,
          bytes: sanitized.bytes,
          contentType: sanitized.mime,
        });

        const lqip = await buildLqip(codec, raw);
        accepted.push({
          raw,
          record: {
            id: imageId,
            key,
            // Alt text is the operator's to write; an empty string is honest and the publish
            // gate refuses to publish without it. Nothing is invented here (14.4, 15.15).
            alt: '',
            width: decoded.width,
            height: decoded.height,
            order: order + accepted.length,
            altSource: 'admin',
            mime: sanitized.mime,
            filename: decoded.label,
            ...(lqip === null ? {} : { lqip }),
            derivativesReady: false,
            derivativeWidths: [],
            derivativeFormats: [],
          },
        });
      }

      if (accepted.length === 0) {
        return jsonResponse({ images: [], rejected }, { status: 422 });
      }

      const nextImages = [...product.images, ...accepted.map((entry) => entry.record)].map(
        (image, index) => ({ ...image, order: index }),
      );
      const candidate = {
        ...product,
        images: nextImages,
        primaryImage: product.primaryImage ?? nextImages[0]?.id,
        updatedAt: new Date().toISOString(),
      };
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
        action: 'add images',
      });

      // 5. Derivatives after the response. `waitUntil` keeps the isolate alive for the work
      // without the operator waiting on it.
      await runAfterResponse(
        context.locals,
        finishDerivatives({
          bucket,
          codec,
          drafts,
          client,
          actor,
          productId: product.id,
          uploads: accepted,
        }),
      );

      return jsonResponse(
        { images: accepted.map((entry) => entry.record), rejected },
        { status: 201 },
      );
    });
  } catch (error) {
    logServerError('images: upload failed', error);
    return toClientErrorResponse(error);
  }
}

/**
 * Generate the derivatives, then patch the image rows that succeeded.
 *
 * Runs outside the request, so it re-resolves the product rather than closing over the copy
 * the request saw: the operator may have edited something in between, and this must only
 * touch the media fields of the images it generated for.
 */
async function finishDerivatives(input: {
  bucket: R2Bucket;
  codec: ImageCodec;
  drafts: Parameters<typeof resolveProduct>[0]['drafts'];
  client: Parameters<typeof resolveProduct>[0]['client'];
  actor: Parameters<typeof saveProductState>[0]['actor'];
  productId: string;
  uploads: readonly AcceptedUpload[];
}): Promise<void> {
  const results = new Map<string, { widths: number[]; formats: string[]; complete: boolean }>();

  for (const upload of input.uploads) {
    try {
      const generated = await generateDerivatives({
        bucket: input.bucket,
        codec: input.codec,
        raw: upload.raw,
        productId: input.productId,
        imageId: upload.record.id,
      });
      if (generated.failed.length > 0) {
        console.error(
          `[images] ${String(generated.failed.length)} derivative(s) failed for ${upload.record.id}`,
        );
      }
      results.set(upload.record.id, {
        widths: generated.widths,
        formats: generated.formats,
        complete: generated.complete,
      });
    } catch (error) {
      logServerError('images: derivative generation failed', error);
    }
  }

  if (results.size === 0) return;

  try {
    const resolved = await resolveProduct(
      { drafts: input.drafts, client: input.client },
      input.productId,
    );
    if (resolved === null) return;

    const images = resolved.product.images.map((image) => {
      const generated = results.get(image.id);
      if (generated === undefined) return image;
      return {
        ...image,
        derivativesReady: generated.complete,
        derivativeWidths: generated.widths,
        derivativeFormats: generated.formats as ProductImageValue['derivativeFormats'],
      };
    });

    const validated = validateProduct({ ...resolved.product, images });
    if (!validated.ok) {
      console.error('[images] derivative patch failed validation');
      return;
    }

    await saveProductState({
      drafts: input.drafts,
      client: input.client,
      product: validated.product,
      from: resolved.product.status,
      actor: input.actor,
      action: 'optimize images',
    });
  } catch (error) {
    logServerError('images: could not record derivative state', error);
  }
}
