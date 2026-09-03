/**
 * The optional enquiry image: same validation as an admin upload, quarantined storage.
 *
 * Requirement 6.11 says an enquiry image runs the *same* checks as an admin upload, is
 * visible only in the leads admin, and is never rendered publicly. All three are structural
 * here rather than procedural:
 *
 * - **Same checks** means literally the same function. `validateUpload` from the image
 *   pipeline is called with the same decoder the admin route uses, so there is no second,
 *   weaker validation path for visitor uploads — which would be the obvious place for one to
 *   appear, since a visitor upload is the less trusted of the two.
 * - **The bytes stored are re-encoded from decoded pixels**, exactly as `sanitizeOriginal`
 *   does for a product photograph. A visitor photographing their living room is very likely
 *   sending EXIF GPS coordinates of their home; storing the container verbatim would put a
 *   customer's address in the operator's bucket. What is written is a pixel re-encode, so the
 *   metadata is gone by construction rather than by a stripping step that could be skipped.
 * - **The key lives under `QUARANTINE_PREFIX`**, which no delivery route resolves.
 *   `/img/[...path]` maps `products/{id}/{imageId}/…` keys only, so there is no URL that
 *   names a quarantined object — the confinement is the absence of a route, not a check
 *   inside one.
 *
 * The key is built from a server-generated lead id and the *sniffed* extension. The
 * visitor's filename never becomes part of a key (Requirement 15.7 applies here for the
 * same reason it applies to the admin path).
 *
 * Requirements: 6.11, 6.18, 15.1–15.7.
 */

import { sanitizeOriginal } from '@/lib/images/derivatives';
import { putImageObject } from '@/lib/images/store';
import { validateUpload, type UploadCandidate, type UploadError } from '@/lib/images/validate';
import type { ImageCodec, RawImage } from '@/lib/images/codec';
import type { R2Bucket } from '@cloudflare/workers-types';

/**
 * The prefix quarantined enquiry attachments live under.
 *
 * Deliberately *not* under `products/`: the delivery route's allowlist is keyed on that
 * prefix, so keeping enquiry images outside it means a bug in the route cannot expose one.
 */
export const QUARANTINE_PREFIX = 'quarantine/leads/';

/** `quarantine/leads/{leadId}/attachment.{ext}` — one attachment per enquiry. */
export function quarantineKey(leadId: string, ext: string): string {
  return `${QUARANTINE_PREFIX}${leadId}/attachment.${ext}`;
}

/** True for a key this module owns. Used by tests and by the admin's own guard. */
export function isQuarantinedKey(key: string): boolean {
  return key.startsWith(QUARANTINE_PREFIX);
}

export type EnquiryImageResult =
  | { readonly ok: true; readonly key: string; readonly bytes: number }
  | { readonly ok: false; readonly error: UploadError };

/**
 * Validate and store one enquiry attachment.
 *
 * Returns the stored key, or the upload pipeline's own error — which already names the
 * specific limit the file exceeded or says the type is not accepted, which is exactly what
 * Requirement 6.18 asks the field-level message to state. Nothing is written when validation
 * fails, so a rejected image leaves no bytes behind.
 */
export async function storeEnquiryImage(
  bucket: R2Bucket,
  codec: ImageCodec,
  leadId: string,
  file: UploadCandidate,
): Promise<EnquiryImageResult> {
  const outcome = await validateUpload(file, (bytes, type) => codec.decode(bytes, type));
  if (!outcome.ok) return { ok: false, error: outcome.error };

  const pixels = outcome.image.pixels;
  if (pixels === undefined) {
    return {
      ok: false,
      error: {
        code: 'DECODE_FAILED',
        message: 'This file could not be opened as an image. Re-export it and try again.',
      },
    };
  }

  const raw: RawImage = {
    width: outcome.image.width,
    height: outcome.image.height,
    rgba: pixels,
  };
  const sanitized = await sanitizeOriginal(codec, raw, outcome.image.type.format);
  const key = quarantineKey(leadId, sanitized.ext);
  await putImageObject(bucket, {
    key,
    bytes: sanitized.bytes,
    contentType: sanitized.mime,
  });

  return { ok: true, key, bytes: sanitized.bytes.length };
}
